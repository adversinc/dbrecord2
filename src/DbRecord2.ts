import MysqlDatabase2 from "./MysqlDatabase2";
const strcount = require('quickly-count-substrings');

// It actually returns Promise<boolean> but DbRecord requires boolean
type TransactionCallback<T extends DbRecord2> = (me: T) => Promise<boolean>|Promise<void>|boolean|void;

interface ChangedFields {
	[key: string]: boolean;
}

/**
 * Represents the database record class.
**/
class DbRecord2 {
	_dbh: MysqlDatabase2;
	_raw: DbRecord2.ObjectInitializer = {};
	_changes: ChangedFields = {};
	/** To hold the existing access method functions */
	_super: object = {};

	/** Initial values of the object */
	_values: DbRecord2.ObjectInitializer;
	/** Object creation options */
	_initOptions: DbRecord2.InitializerOptions;

	_tableName: string;
	_locateField: string;
	_keysList: string[];

	// If this object is new, does not exist in DB
	_dbObjectExists: boolean = false;

	static _table(): string { throw "DbRecord can't be created directly"; }
	static _locatefield(): string { throw "DbRecord can't be created directly"; }
	static _keys(): string[] { return []; }

	/**
	 * Creates the class instance. If options.${_locatefield()} parameter is specified,
	 * reads the data from the database and put them into the internal structures
	 * (see _init() and _read())
	 * @param {Object} [values]
	 * @param {Object} [initOptions]
	 * @param {Boolean} [initOptions.forUpdate] - read record with FOR UPDATE flag,
	 * 	blocking it within the transaction
	 */
	constructor(values: DbRecord2.ObjectInitializer = {},
							initOptions: DbRecord2.InitializerOptions = {}) {
		this._tableName = (this.constructor as any)._table();
		this._locateField = (this.constructor as any)._locatefield();
		this._keysList = (this.constructor as any)._keys();

		this._values = Object.assign({}, values);
		this._initOptions = Object.assign({}, initOptions);

		if(Object.keys(this._values).length) {
			this._dbObjectExists = true;
		}
	}

	/**
	 * Initialize class structures, read database
	 * @returns {Promise<void>}
	 */
	async init() {
		// Use either locally provided or database handler factory
		if(this._initOptions.dbh) {
			this._dbh = this._initOptions.dbh;
		} else {
			this._dbh = await this._getDbhClass().masterDbh();
		}

		//console.log("using trxDbh:", this._dbh.cid);
		await this._init();
	}


	/**
	 * Tries creating an object by locate field/keys. Unlike constructor, does
	 * not throw an error for non-existing record and returns null instead.
	 * @param values
	 * @param options
	 */
	static async tryCreate<T extends DbRecord2>(this: { new({},{}): T },
			values: DbRecord2.ObjectInitializer = {},
			options: DbRecord2.InitializerOptions = {}): Promise<T> {
		try {
			const obj = new this(values, options);
			await obj.init();
			return obj;
		} catch(ex) {
			if(ex.message == "E_DB_NO_OBJECT") { return null; }
			else { throw ex; }
		}
	}

	/** Creates a new database record, populating it from the fields list
	 * @param {Object} fields
	 * @param {Object} [options] - options for database creation
	 * @returns {DbRecord} the newly created object
	 */
	static async newRecord(fields: DbRecord2.ObjectInitializer, options?: DbRecord2.NewRecordOptions): Promise<DbRecord2> {
		const obj = new this();
		await obj.init();

		Object.keys(fields).forEach((k) => {
			obj._changes[k] = true;
			obj._raw[k] = fields[k];
		});

		if(!options?.noCommit) {
			await obj.commit({behavior: options?.behavior || "REPLACE"});
		}
		return obj;
	}

	/**
	 * Save accumulated changed fields, if any
	 * @param {Object} options
	 * @param {"REPLACE"|"INSERT"} options.behavior - if "REPLACE", does "REPLACE INTO".
	 * 	"INSERT" forces to try inserting the record, regardless of _locateField
	 * 	existance.
	 */
	async commit(options: DbRecord2.CommitOptions = {}) {
		let sql = "";

		if(Object.keys(this._changes).length === 0) {
			return;
		}

		// For newly created records we force INSERT behavior
		if(!this._dbObjectExists) {
			options.behavior = "INSERT";
		}
		this._dbh._debug(`Commit behavior: ${options.behavior}`);

		if(this._raw[this._locateField] !== undefined && options.behavior !== "INSERT") {
			sql = "UPDATE ";
		} else if(options.behavior === "REPLACE") {
			sql = "REPLACE INTO ";
		} else {
			sql = "INSERT INTO ";
		}

		sql += `${this._tableName} SET `;
		const fields = [];
		const values = [];
		Object.keys(this._changes).forEach((field) => {
			fields.push(field + "=?");
			values.push(this._raw[field]);
		});

		sql += fields.join(",");

		if(this._raw[this._locateField] !== undefined && options.behavior !== "INSERT") {
			sql += ` WHERE ${this._locateField}=?`;
			values.push(this._raw[this._locateField]);
		}

		if(this._initOptions.queryComment) {
			sql += ` /*!9999999 ${this._initOptions.queryComment} */`;
		}

		// Compare our dbh.cid and current transaction dbh
		const trxDbh = this._getDbhClass().masterDbhRO();

		//console.log("Comparing dbh:", this._dbh.cid, trxDbh? trxDbh.cid: undefined);

		if(trxDbh) {
			if(this._dbh.cid !== trxDbh.cid) {
				throw new Error(`${this.constructor.name}: Object has to be re-created in transaction`);
			}
		}

		//this._dbh._debug(`Commit SQL: ${sql} / ${JSON.stringify(values)}`);

		const res = await this._dbh.queryAsync(sql, values);

		this._changes = {};
		this._dbObjectExists = true;

		// During the first insert the ${_locatefield()} field will be empty, and,
		// probably, generated by mysql
		if(this._raw[this._locateField] === undefined) {
			this._raw[this._locateField] = res.insertId;

			if(this[this._locateField] === undefined) {
				this._createAccessMethod(this._locateField);
			}
		}
	}

	/**
	 * Initializes class from the database or as an empty record.
	 *
	 * If 'options' contains a property named as _locatefield() defines, then we
	 * try to initialize from the database. Exception is thrown if there's no
	 * record found.
	 *
	 * @param options
	 * @protected
	 */
	async _init() {
		let byKey = null;
		const keyArgs = [];

		this._keysList.sort(commaSort).forEach((k) => {
			// console.log("key", k);
			if(byKey != null) { return; }

			// Check if all key parts are present
			let fits = true;
			k.split(",").forEach((kpart) => {
				if(!(kpart in this._values)) { fits = false; }
			});

			if(fits) {
				// Key fits, remember it and its arguments
				byKey = k.split(",");
				byKey.forEach((kpart) => {
					keyArgs.push(this._values[kpart]);
				});
			}
		});

		// if "_locateField" is set, then we need to read our data from the database
		if(this._locateField in this._values) {
			await this._read(this._values[this._locateField]);
		}
		else if(byKey) {
			await this._readByKey(byKey, keyArgs);
		}
		else {
			// else create a new record: read the table info and build access methods
			await this._initEmpty();
		}
	}

	/**
	 * Reads values from the database, puts them into _raw and creates a function
	 * to get each value, so we can access fields as:
	 * obj.field();
	 * obj.field("new value");
	 * @protected
	 * @param {*} locateValue - the database unique id of the record
	 * @param {String} byKey - the field to search on. $_locateField by default.
	 */
	async _read(locateValue: MysqlDatabase2.FieldValue, byKey: string = undefined) {
		let field = byKey || this._locateField;
		const forUpdate = this._initOptions.forUpdate? "FOR UPDATE": "";
		const comment = this._initOptions.queryComment? ` /*!9999999 ${this._initOptions.queryComment} */`: "";

		const rows = await this._dbh.queryAsync(`SELECT * FROM ${this._tableName} WHERE ${field}=? LIMIT 1 ${forUpdate}${comment}`,
			[locateValue]);
		return this._createFromRows(rows);
	}


	/**
	 * Does the same work as _read, but accepts the secondary keys and values arrays
	 * @param keys {Array}
	 * @param values {Array}
	 * @private
	 */
	async _readByKey(keys, values) {
		const fields = keys.join("=? AND ") + "=?";
		const forUpdate = this._initOptions.forUpdate? "FOR UPDATE": "";
		const comment = this._initOptions.queryComment? ` /*!9999999 ${this._initOptions.queryComment} */`: "";

		const rows = await this._dbh.queryAsync(`SELECT * FROM ${this._tableName} WHERE ${fields} LIMIT 1 ${forUpdate}${comment}`,
			values);
		return this._createFromRows(rows);
	}


	/**
	 * Initialize object and methods			if(args.Length >= 1 && !UUID.TryParse(args[0], out folder)) {
				return "FAIL: error parsing folder UUID";
			}
	 from rows array
	 * @param rows
	 * @private
	 */
	_createFromRows(rows) {
		if(rows.length == 0) {
			throw new Error("E_DB_NO_OBJECT");
		}

		this._raw = rows[0];

		// Create access methods for all fields
		Object.keys(this._raw).forEach((field) => { this._createAccessMethod(field); });
	}

	/**
	 * Initializes an empty object
	 * @private
	 */
	async _initEmpty() {
		const comment = this._initOptions.queryComment? ` /*!9999999 ${this._initOptions.queryComment} */`: "";
		//console.log(`t: ${JSON.stringify(this._initOptions)}, ${comment}`);
		const rows = await this._dbh.queryAsync(`DESCRIBE ${this._tableName}${comment}`);
		rows.forEach((field) => { this._createAccessMethod(field.Field); });
	}

	/**
	 * The template for access methods. Reads or sets the value of the object field.
	 * @param field
	 * @param value
	 * @private
	 */
	_accessField(field: string, value: DbRecord2.DbField) {
		// To set NULL field: class.field(null)
		if(value !== undefined) {
			this._changes[field] = true;
			this._raw[field] = value;
		}

		return this._raw[field];
	}

	/**
	 * Creates a function within this class to get/set the certain field
	 * @param field
	 * @private
	 */
	_createAccessMethod(field: string) {
		//console.log("creating", field, typeof this[field]);
		const f = (value = undefined) => { return this._accessField(field, value); };

		// If access function already exists, do not overwrite it. Instead, add a function
		// to this._super object
		if(typeof this[field] === "function") {
			this._super[field] = f;
		} else {
			this[field] = f;
		}
	}


	/**
	 * Removes the record from the database. No verification or integrity checks
	 * are being performed, they are up to caller.
	 */
	async deleteRecord() {
		const comment = this._initOptions.queryComment? ` /*!9999999 ${this._initOptions.queryComment} */`: "";
		await this._dbh.queryAsync(`DELETE FROM ${this._tableName} WHERE ${this._locateField} = ?${comment}`,
			[ this[this._locateField]() ]);
	}

	/**
	 * Returns master database handle currently in-use. To be used in static
	 * methods of DbRecord
	 *
	 * @returns {MysqlDatabase2} current mysql database connection class
	 */
	static masterDbh() {
		return this._getDbhClassStatic().masterDbh();
	}



	/**
	 * Runs through database objects according the options, and calls the
	 * callback routine for each.
	 *
	 * Callback may return false to stop iterating.
	 *
	 * @param {Object} options
	 * @param {String} options.any_lowercase_field - the field to get added to WHERE
	 * @param {[String]} options.whereCond - optional WHERE conditions to add
	 * @param {[String]} options.whereParam - optional parameters for whereCond's
	 * @param {Boolean} [options.forUpdate] - lock records for update
	 * @param {String} [options.ORDERBY] - the sort field or expression
	 * @param {String} [options.LIMIT] - the SQL LIMIT expression
	 * @param {Boolean} [options.DEBUG_SQL_QUERY] - send SQL to console log
	 * @param {Function} cb - the callback function, it receives two arguments:
	 * 	the current iteration DbRecord and the "options" object
	 *
	 * @returns {Number} the number of rows found
	 */
	static async forEach<T extends DbRecord2>(this: { new(): T }, options: DbRecord2.ForEachOptions, cb: DbRecord2.ForeachCallback<T>) {
		const where: string[] = [];
		const qparam: DbRecord2.DbField[] = [];
		const sql = (this as unknown as typeof DbRecord2)._prepareForEach(options, where, qparam);

		//
		// Iterate
		const _dbh = await (this as unknown as typeof DbRecord2)._getDbhClassStatic().masterDbh();

		/*
		if(TARGET === "development") {
			console.log(`${_dbh._db.threadId}: will be running forEach query`);
		}
		*/

		const rows = await _dbh.queryAsync(sql, qparam);
		options.TOTAL = rows.length;

		if(cb) {
			options.COUNTER = 0;

			for(const row of rows) {
				options.COUNTER++;

				const itemInit = {};
				itemInit[(this as unknown as typeof DbRecord2)._locatefield()] = row[(this as unknown as typeof DbRecord2)._locatefield()];
				let obj: T = null;

				if(!options.noObjectCreate) {
					obj = new (this as unknown as typeof DbRecord2)(itemInit) as T;
					if(options?.queryComment) {
						obj._initOptions.queryComment = options.queryComment;
					}
					await obj.init();
				}

				if(options.provideRaw) {
					options.raw = row;
				}

				// Wait for iterator to end
				const res = await cb(obj, options);
				if(res === false) { break; }
			}
		} else {
			options.COUNTER = options.TOTAL;
		}

		return options.COUNTER;
	}


	/**
	 * Prepares SQL and param arrays for forEach()
	 * @param options
	 * @param where
	 * @param qparam
	 * @returns {string}
	 * @private
	 */
	static _prepareForEach(options: DbRecord2.ForEachOptions, where, qparam) {
		let sql = `SELECT ${this._locatefield()} FROM ${this._table()}`;

		// WHERE fields
		Object.keys(options).forEach((k) => {
			if(k.match(/[^a-z0-9._]/)) { return; }

			where.push(`${k}=?`);
			qparam.push(options[k]);
		});

		if(options.whereCond) {
			options.whereCond.forEach((q) => {
				where.push(`(${q})`);
			});
		}

		if(options.whereParam) {
			options.whereParam.forEach((q) => {
				qparam.push(q);
			});
		}

		if(where.length > 0) {
			sql += " WHERE " + where.join(" AND ");
		}


		// ORDER BY
		if(options.ORDERBY && !options.ORDERBY.match(/[^a-zA-Z0-9 ><,()*_-]/)) {
			sql += " ORDER BY " + options.ORDERBY;
		}

		// LIMIT
		if(options.LIMIT && !options.LIMIT.toString().match(/[^0-9, ]/)) {
			sql += " LIMIT " + options.LIMIT;
		}

		if(options.forUpdate) { sql += " FOR UPDATE"; }

		if(options.queryComment) {
			sql += ` /*!9999999 ${options.queryComment} */`;
		}

		if(options.debugSql) {
			console.log(sql, qparam);
		}

		return sql;
	}


	/**
	 * Starts a transaction and creates an instance of our object within that
	 * transaction, passing it to the callback
	 * @param {Function} cb - function to run with a "me" newly created objec
	 * @returns {Promise<void>}
	 */
	async transactionWithMe<T extends DbRecord2>(this: T, cb: TransactionCallback<T>) {
		const Class = this.constructor;

		// Make sure we are committed
		if(Object.keys(this._changes).length > 0) {
			throw new Error(`${Class.name}: Object has uncommitted changes before transaction`);
		}

		const dbh = await (Class as any).masterDbh();
		await dbh.execTransactionAsync(async () => {
			const params = {};
			params[this._locateField] = this[this._locateField]();
			const me = new (Class as any)(params);
			await me.init();

			return await cb(me);
		});

		// Re-read our object after the transaction
		await this._read(this[this._locateField]());
	}

	/**
	 * Returns MysqlDatabase class used for this DbRecord class
	 * @private
	 */
	static _getDbhClassStatic(): typeof MysqlDatabase2 {
		return MysqlDatabase2;
	}
	/**
	 * Returns MysqlDatabase class used for this DbRecord object
	 * @private
	 */
	_getDbhClass(): any  {
		return MysqlDatabase2;
	}
}

namespace DbRecord2 {
	/**
	 * Possible types of db fields
	 */
	export type DbField = string | number | Date;

	/**
	 * Standard options to initialize record
	 */
	export interface InitializerOptions {
		dbh?: MysqlDatabase2;
		forUpdate?: boolean;
		// A comment to add to the query
		queryComment?: string;
	}

	/**
	 * Custom options to initialize record
	 */
	export interface ObjectInitializer {
		[key: string]: DbRecord2.DbField;
	}


	export interface CommitOptions {
		behavior?: "INSERT"|"REPLACE";
	}

	export interface NewRecordOptions {
		noCommit?: boolean;
		behavior?: "INSERT"|"REPLACE";
	}

	export interface ForEachOptions {
		/** Total objects in iteration */
		TOTAL?: number;
		/** Current object index in iteration */
		COUNTER?: number;

		/** Ordering field/expression */
		ORDERBY?: string;
		/** Limit SQL expression */
		LIMIT?: string;

		/** Log resulting query */
		debugSql?: boolean;

		/** A commend to add to the query */
		queryComment?: string;

		/**
		 * Raw object fields if ordered by 'provideRaw'
		 */
		raw?: object;

		/**
		 * Don't create an object while calling callback
		 */
		noObjectCreate?: boolean;
		/** Provide the raw representation of the object */
		provideRaw?: boolean;

		/** If required to lock records with FOR UPDATE */
		forUpdate?: boolean;

		whereCond?: string[];
		whereParam?: DbRecord2.DbField[];
	}

	export type ForeachCallback<T> = (item: T, options: DbRecord2.ForEachOptions) => Promise<boolean|void>;

	/**
	 * Field access function types
	 */
	export namespace Column {
		export type String = (value?: string) => string;
		export type Number = (value?: number) => number;
		export type DateTime = (value?: Date) => Date;
		/** Acts like a string by default but can be set to specific string set */
		export type Enum<T extends string = string> = (value?: T) => T;
		/** Acts like a string by default but can be set to specific string set */
		export type Set<T extends string = string> = (value?: T) => T;
	}


	/**
	 * Add value to mysql SET field
	 * @param currentValue
	 * @param newValue
	 */
	export function setFieldSet(currentValue: string, newValue: string): string {
		const parts = (typeof(currentValue) === "string" && currentValue !== "")?
			currentValue.split(","):
			[];
		parts.push(newValue);
		return parts.join(",");
	}

	/**
	 * Remove value from mysql SET field
	 * @param currentValue
	 * @param toRemove
	 */
	export function setFieldRemove(currentValue: string, toRemove: string): string {
		let parts = (typeof(currentValue) === "string")? currentValue.split(","): [];
		parts = parts.filter(v => v !== toRemove);
		return parts.join(",");
	}

	/**
	 * Check if value in in mysql SET field
	 * @param currentValue
	 * @param toRemove
	 */
	export function setFieldCheck(currentValue: string, check: string): boolean {
		const parts = (typeof(currentValue) === "string")? currentValue.split(","): [];
		return parts.includes(check);
	}
}


/**
 * The sorting function to get entries with more commas first
 * @param a
 * @param b
 */
function commaSort(a,b) {
	const ca = strcount(a, ",");
	const cb = strcount(b, ",");
	return ca>cb? -1 : 1;
}

export default DbRecord2;

import MysqlDatabase2 from "./MysqlDatabase2";
const strcount = require('quickly-count-substrings');

/**
 * Represents the database record class.
**/
export default class DbRecord2 {
	static _table() { throw "DbRecord can't be created directly"; }
	static _locatefield() { throw "DbRecord can't be created directly"; }
	static _keys() { return []; }

	/**
	 * Creates the class instance. If options.${_locatefield()} parameter is specified,
	 * reads the data from the database and put them into the internal structures
	 * (see _init() and _read())
	 * @param {Object} [options]
	 */
	constructor(options = {}) {
		/**
		 * The database handler to work with
		 */
		this._raw = {};
		this._changes = {};
		this._super = {}; // To hold the existing access method functions

		this._tableName = this.constructor._table();
		this._locateField = this.constructor._locatefield();

		this._options = Object.assign({}, options);
	}

	/**
	 * Initialize class structures, read database
	 * @returns {Promise<void>}
	 */
	async init() {
		// Use either locally provided or database handler factory
		if(this._options.dbh) {
			this._dbh = this._options.dbh;
		} else {
			this._dbh = await MysqlDatabase2.masterDbh();
		}

		//console.log("using trxDbh:", this._dbh.cid);

		await this._init(this._options);
	}


	/**
	 * Tries creating an object by locate field/keys. Unlike constructor, does
	 * not throw an error for non-existing record and returns null instead.
	 * @param options
	 */
	static async tryCreate(options = {}) {
		try {
			const obj = new this(options);
			await obj.init();
			return obj;
		} catch(ex) {
			if(ex.message == "E_DB_NO_OBJECT") { return null; }
			else { throw ex; }
		}
	}

	/**
	 * Save accumulated changed fields, if any
	 */
	async commit() {
		let sql = "";

		if(Object.keys(this._changes).length === 0) {
			return;
		}

		if(this._raw[this._locateField] !== undefined) {
			sql = "UPDATE ";
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

		if(this._raw[this._locateField] !== undefined) {
			sql += ` WHERE ${this._locateField}=?`;
			values.push(this._raw[this._locateField]);
		}

		// Compare our dbh.cid and current transaction dbh
		const trxDbh = MysqlDatabase2.masterDbhRO();

		//console.log("Comparing dbh:", this._dbh.cid, trxDbh? trxDbh.cid: undefined);

		if(trxDbh) {
			if(this._dbh.cid !== trxDbh.cid) {
				throw new Error(`${this.constructor.name}: Object has to be re-created in transaction`);
			}
		}

		const res = await this._dbh.queryAsync(sql, values);
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
	async _init(options) {
		let byKey = null;
		const keyArgs = [];

		this.constructor._keys().sort(commaSort).forEach((k) => {
			// console.log("key", k);
			if(byKey != null) { return; }

			// Check if all key parts are present
			let fits = true;
			k.split(",").forEach((kpart) => {
				if(!(kpart in options)) { fits = false; }
			});

			if(fits) {
				// Key fits, remember it and its arguments
				byKey = k.split(",");
				byKey.forEach((kpart) => {
					keyArgs.push(options[kpart]);
				});
			}
		});

		// if "_locateField" is set, then we need to read our data from the database
		if(this._locateField in options) {
			await this._read(options[this._locateField]);
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
	async _read(locateValue, byKey) {
		let field = byKey || this._locateField;

		const rows = await this._dbh.queryAsync(`SELECT * FROM ${this._tableName} WHERE ${field}=? LIMIT 1`,
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

		const rows = await this._dbh.queryAsync(`SELECT * FROM ${this._tableName} WHERE ${fields} LIMIT 1`,
			values);
		return this._createFromRows(rows);
	}


	/**
	 * Initialize object and methods from rows array
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
		const rows = await this._dbh.queryAsync(`DESCRIBE ${this._tableName}`);
		rows.forEach((field) => { this._createAccessMethod(field.Field); });
	}

	/**
	 * The template for access methods. Reads or sets the value of the object field.
	 * @param field
	 * @param value
	 * @private
	 */
	_accessField(field, value) {
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
	_createAccessMethod(field) {
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
		await this._dbh.queryAsync(`DELETE FROM ${this._tableName} WHERE ${this._locateField} = ?`,
			[ this[this._locateField]() ]);
	}

	/**
	 * Returns master database handle currently in-use. To be used in static
	 * methods of DbRecord
	 *
	 * @returns {MysqlDatabase2} current mysql database connection class
	 */
	static masterDbh() {
		return MysqlDatabase2.masterDbh();
	}



	/**
	 * Runs through database objects according the options, and calls the
	 * callback routine for each.
	 *
	 * @param {Object} options
	 * @param {String} options.any_lowercase_field - the field to get added to WHERE
	 * @param {[String]} options.whereCond - optional WHERE conditions to add
	 * @param {[String]} options.whereParam - optional parameters for whereCond's
	 * @param {Function} cb - the callback function, it receives two arguments:
	 * 	the current iteration DbRecord and the "options" object
	 *
	 * @returns {Number} the number of rows found
	 */
	static async forEach(options, cb) {
		let sql = `SELECT ${this._locatefield()} FROM ${this._table()}`;
		const where = [];
		const qparam = [];

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
		if(options.ORDERBY && !options.ORDERBY.match(/[^a-zA-Z0-9 ><-]/)) {
			sql += " ORDER BY " + options.ORDERBY;
		}

		// LIMIT
		if(options.LIMIT && !options.LIMIT.toString().match(/[^0-9, ]/)) {
			sql += " LIMIT " + options.LIMIT;
		}

		if(options.DEBUG_SQL_QUERY) {
			console.log(sql, qparam);
		}

		//
		// Iterate
		const _dbh = await MysqlDatabase2.masterDbh();
		const rows = await _dbh.queryAsync(sql, qparam);
		options.TOTAL = rows.length;

		if(cb) {
			options.COUNTER = 0;

			for(const row of rows) {
				options.COUNTER++;

				const o = {};
				o[this._locatefield()] = row[this._locatefield()];
				const obj = new this(o);
				await obj.init();

				// Wait for iterator to end
				await cb(obj, options);
			}
		} else {
			options.COUNTER = options.TOTAL;
		}

		return options.COUNTER;
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

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const MysqlDatabase2_1 = __importDefault(require("./MysqlDatabase2"));
const strcount = require('quickly-count-substrings');
/**
 * Represents the database record class.
**/
class DbRecord2 {
    static _table() { throw "DbRecord can't be created directly"; }
    static _locatefield() { throw "DbRecord can't be created directly"; }
    static _keys() { return []; }
    /**
     * Creates the class instance. If options.${_locatefield()} parameter is specified,
     * reads the data from the database and put them into the internal structures
     * (see _init() and _read())
     * @param {Object} [values]
     * @param {Object} [initOptions]
     * @param {Boolean} [initOptions.forUpdate] - read record with FOR UPDATE flag,
     * 	blocking it within the transaction
     */
    constructor(values = {}, initOptions = {}) {
        this._raw = {};
        this._changes = {};
        /** To hold the existing access method functions */
        this._super = {};
        // If this object is new, does not exist in DB
        this._dbObjectExists = false;
        this._tableName = this.constructor._table();
        this._locateField = this.constructor._locatefield();
        this._keysList = this.constructor._keys();
        this._values = Object.assign({}, values);
        this._initOptions = Object.assign({}, initOptions);
        if (Object.keys(this._values).length) {
            this._dbObjectExists = true;
        }
    }
    /**
     * Initialize class structures, read database
     * @returns {Promise<void>}
     */
    async init() {
        // Use either locally provided or database handler factory
        if (this._initOptions.dbh) {
            this._dbh = this._initOptions.dbh;
        }
        else {
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
    static async tryCreate(values = {}, options = {}) {
        try {
            const obj = new this(values, options);
            await obj.init();
            return obj;
        }
        catch (ex) {
            if (ex.message == "E_DB_NO_OBJECT") {
                return null;
            }
            else {
                throw ex;
            }
        }
    }
    /** Creates a new database record, populating it from the fields list
     * @param {Object} fields
     * @param {Object} [options] - options for database creation
     * @returns {DbRecord} the newly created object
     */
    static async newRecord(fields, options) {
        const obj = new this();
        await obj.init();
        Object.keys(fields).forEach((k) => {
            obj._changes[k] = true;
            obj._raw[k] = fields[k];
        });
        if (!(options === null || options === void 0 ? void 0 : options.noCommit)) {
            await obj.commit({ behavior: (options === null || options === void 0 ? void 0 : options.behavior) || "REPLACE" });
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
    async commit(options = {}) {
        let sql = "";
        if (Object.keys(this._changes).length === 0) {
            return;
        }
        // For newly created records we force INSERT behavior
        if (!this._dbObjectExists) {
            options.behavior = "INSERT";
        }
        this._dbh._debug(`Commit behavior: ${options.behavior}`);
        if (this._raw[this._locateField] !== undefined && options.behavior !== "INSERT") {
            sql = "UPDATE ";
        }
        else if (options.behavior === "REPLACE") {
            sql = "REPLACE INTO ";
        }
        else {
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
        if (this._raw[this._locateField] !== undefined && options.behavior !== "INSERT") {
            sql += ` WHERE ${this._locateField}=?`;
            values.push(this._raw[this._locateField]);
        }
        if (this._initOptions.queryComment) {
            sql += ` /*!9999999 ${this._initOptions.queryComment} */`;
        }
        // Compare our dbh.cid and current transaction dbh
        const trxDbh = this._getDbhClass().masterDbhRO();
        //console.log("Comparing dbh:", this._dbh.cid, trxDbh? trxDbh.cid: undefined);
        if (trxDbh) {
            if (this._dbh.cid !== trxDbh.cid) {
                throw new Error(`${this.constructor.name}: Object has to be re-created in transaction`);
            }
        }
        //this._dbh._debug(`Commit SQL: ${sql} / ${JSON.stringify(values)}`);
        const res = await this._dbh.queryAsync(sql, values);
        this._changes = {};
        this._dbObjectExists = true;
        // During the first insert the ${_locatefield()} field will be empty, and,
        // probably, generated by mysql
        if (this._raw[this._locateField] === undefined) {
            this._raw[this._locateField] = res.insertId;
            if (this[this._locateField] === undefined) {
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
            if (byKey != null) {
                return;
            }
            // Check if all key parts are present
            let fits = true;
            k.split(",").forEach((kpart) => {
                if (!(kpart in this._values)) {
                    fits = false;
                }
            });
            if (fits) {
                // Key fits, remember it and its arguments
                byKey = k.split(",");
                byKey.forEach((kpart) => {
                    keyArgs.push(this._values[kpart]);
                });
            }
        });
        // if "_locateField" is set, then we need to read our data from the database
        if (this._locateField in this._values) {
            await this._read(this._values[this._locateField]);
        }
        else if (byKey) {
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
    async _read(locateValue, byKey = undefined) {
        let field = byKey || this._locateField;
        const forUpdate = this._initOptions.forUpdate ? "FOR UPDATE" : "";
        const comment = this._initOptions.queryComment ? ` /*!9999999 ${this._initOptions.queryComment} */` : "";
        const rows = await this._dbh.queryAsync(`SELECT * FROM ${this._tableName} WHERE ${field}=? LIMIT 1 ${forUpdate}${comment}`, [locateValue]);
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
        const forUpdate = this._initOptions.forUpdate ? "FOR UPDATE" : "";
        const comment = this._initOptions.queryComment ? ` /*!9999999 ${this._initOptions.queryComment} */` : "";
        const rows = await this._dbh.queryAsync(`SELECT * FROM ${this._tableName} WHERE ${fields} LIMIT 1 ${forUpdate}${comment}`, values);
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
        if (rows.length == 0) {
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
        const comment = this._initOptions.queryComment ? ` /*!9999999 ${this._initOptions.queryComment} */` : "";
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
    _accessField(field, value) {
        // To set NULL field: class.field(null)
        if (value !== undefined) {
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
        if (typeof this[field] === "function") {
            this._super[field] = f;
        }
        else {
            this[field] = f;
        }
    }
    /**
     * Removes the record from the database. No verification or integrity checks
     * are being performed, they are up to caller.
     */
    async deleteRecord() {
        const comment = this._initOptions.queryComment ? ` /*!9999999 ${this._initOptions.queryComment} */` : "";
        await this._dbh.queryAsync(`DELETE FROM ${this._tableName} WHERE ${this._locateField} = ?${comment}`, [this[this._locateField]()]);
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
    static async forEach(options, cb) {
        const where = [];
        const qparam = [];
        const sql = this._prepareForEach(options, where, qparam);
        //
        // Iterate
        const _dbh = await this._getDbhClassStatic().masterDbh();
        /*
        if(TARGET === "development") {
            console.log(`${_dbh._db.threadId}: will be running forEach query`);
        }
        */
        const rows = await _dbh.queryAsync(sql, qparam);
        options.TOTAL = rows.length;
        if (cb) {
            options.COUNTER = 0;
            for (const row of rows) {
                options.COUNTER++;
                const itemInit = {};
                itemInit[this._locatefield()] = row[this._locatefield()];
                let obj = null;
                if (!options.noObjectCreate) {
                    obj = new this(itemInit);
                    if (options === null || options === void 0 ? void 0 : options.queryComment) {
                        obj._initOptions.queryComment = options.queryComment;
                    }
                    await obj.init();
                }
                if (options.provideRaw) {
                    options.raw = row;
                }
                // Wait for iterator to end
                const res = await cb(obj, options);
                if (res === false) {
                    break;
                }
            }
        }
        else {
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
    static _prepareForEach(options, where, qparam) {
        let sql = `SELECT ${this._locatefield()} FROM ${this._table()}`;
        // WHERE fields
        Object.keys(options).forEach((k) => {
            if (k.match(/[^a-z0-9._]/)) {
                return;
            }
            where.push(`${k}=?`);
            qparam.push(options[k]);
        });
        if (options.whereCond) {
            options.whereCond.forEach((q) => {
                where.push(`(${q})`);
            });
        }
        if (options.whereParam) {
            options.whereParam.forEach((q) => {
                qparam.push(q);
            });
        }
        if (where.length > 0) {
            sql += " WHERE " + where.join(" AND ");
        }
        // ORDER BY
        if (options.ORDERBY && !options.ORDERBY.match(/[^a-zA-Z0-9 ><,()*_-]/)) {
            sql += " ORDER BY " + options.ORDERBY;
        }
        // LIMIT
        if (options.LIMIT && !options.LIMIT.toString().match(/[^0-9, ]/)) {
            sql += " LIMIT " + options.LIMIT;
        }
        if (options.forUpdate) {
            sql += " FOR UPDATE";
        }
        if (options.queryComment) {
            sql += ` /*!9999999 ${options.queryComment} */`;
        }
        if (options.debugSql) {
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
    async transactionWithMe(cb) {
        const Class = this.constructor;
        // Make sure we are committed
        if (Object.keys(this._changes).length > 0) {
            throw new Error(`${Class.name}: Object has uncommitted changes before transaction`);
        }
        const dbh = await Class.masterDbh();
        await dbh.execTransactionAsync(async () => {
            const params = {};
            params[this._locateField] = this[this._locateField]();
            const me = new Class(params);
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
    static _getDbhClassStatic() {
        return MysqlDatabase2_1.default;
    }
    /**
     * Returns MysqlDatabase class used for this DbRecord object
     * @private
     */
    _getDbhClass() {
        return MysqlDatabase2_1.default;
    }
}
(function (DbRecord2) {
    /**
     * Add value to mysql SET field
     * @param currentValue
     * @param newValue
     */
    function setFieldSet(currentValue, newValue) {
        const parts = (typeof (currentValue) === "string" && currentValue !== "") ?
            currentValue.split(",") :
            [];
        parts.push(newValue);
        return parts.join(",");
    }
    DbRecord2.setFieldSet = setFieldSet;
    /**
     * Remove value from mysql SET field
     * @param currentValue
     * @param toRemove
     */
    function setFieldRemove(currentValue, toRemove) {
        let parts = (typeof (currentValue) === "string") ? currentValue.split(",") : [];
        parts = parts.filter(v => v !== toRemove);
        return parts.join(",");
    }
    DbRecord2.setFieldRemove = setFieldRemove;
    /**
     * Check if value in in mysql SET field
     * @param currentValue
     * @param toRemove
     */
    function setFieldCheck(currentValue, check) {
        const parts = (typeof (currentValue) === "string") ? currentValue.split(",") : [];
        return parts.includes(check);
    }
    DbRecord2.setFieldCheck = setFieldCheck;
})(DbRecord2 || (DbRecord2 = {}));
/**
 * The sorting function to get entries with more commas first
 * @param a
 * @param b
 */
function commaSort(a, b) {
    const ca = strcount(a, ",");
    const cb = strcount(b, ",");
    return ca > cb ? -1 : 1;
}
exports.default = DbRecord2;

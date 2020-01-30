import MysqlDatabase2 from "./MysqlDatabase2";
interface DbRecordOptions {
    dbh?: MysqlDatabase2;
    forUpdate?: boolean;
}
interface CommitOptions {
    behavior?: "INSERT" | "REPLACE";
}
declare const _default: {
    new (options?: DbRecordOptions): {
        _dbh: MysqlDatabase2;
        _raw: object;
        _changes: object;
        _super: object;
        _options: DbRecordOptions;
        _tableName: string;
        _locateField: string;
        /**
         * Initialize class structures, read database
         * @returns {Promise<void>}
         */
        init(): Promise<void>;
        /**
         * Save accumulated changed fields, if any
         * @param {Object} options
         * @param {"REPLACE"|"INSERT"} options.behavior - if "REPLACE", does "REPLACE INTO".
         * 	"INSERT" forces to try inserting the record, regardless of _locateField
         * 	existance.
         */
        commit(options?: CommitOptions): Promise<void>;
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
        _init(options: any): Promise<void>;
        /**
         * Reads values from the database, puts them into _raw and creates a function
         * to get each value, so we can access fields as:
         * obj.field();
         * obj.field("new value");
         * @protected
         * @param {*} locateValue - the database unique id of the record
         * @param {String} byKey - the field to search on. $_locateField by default.
         */
        _read(locateValue: string | number | Date, byKey?: any): Promise<void>;
        /**
         * Does the same work as _read, but accepts the secondary keys and values arrays
         * @param keys {Array}
         * @param values {Array}
         * @private
         */
        _readByKey(keys: any, values: any): Promise<void>;
        /**
         * Initialize object and methods			if(args.Length >= 1 && !UUID.TryParse(args[0], out folder)) {
                    return "FAIL: error parsing folder UUID";
                }
         from rows array
         * @param rows
         * @private
         */
        _createFromRows(rows: any): void;
        /**
         * Initializes an empty object
         * @private
         */
        _initEmpty(): Promise<void>;
        /**
         * The template for access methods. Reads or sets the value of the object field.
         * @param field
         * @param value
         * @private
         */
        _accessField(field: any, value: any): any;
        /**
         * Creates a function within this class to get/set the certain field
         * @param field
         * @private
         */
        _createAccessMethod(field: any): void;
        /**
         * Removes the record from the database. No verification or integrity checks
         * are being performed, they are up to caller.
         */
        deleteRecord(): Promise<void>;
        /**
         * Starts a transaction and creates an instance of our object within that
         * transaction, passing it to the callback
         * @param {Function} cb - function to run with a "me" newly created objec
         * @returns {Promise<void>}
         */
        transactionWithMe(cb: any): Promise<void>;
        /**
         * Returns MysqlDatabase class used for this DbRecord object
         * @private
         */
        _getDbhClass(): any;
    };
    _table(): string;
    _locatefield(): string;
    _keys(): string[];
    /**
     * Tries creating an object by locate field/keys. Unlike constructor, does
     * not throw an error for non-existing record and returns null instead.
     * @param options
     */
    tryCreate(options?: {}): Promise<{
        _dbh: MysqlDatabase2;
        _raw: object;
        _changes: object;
        _super: object;
        _options: DbRecordOptions;
        _tableName: string;
        _locateField: string;
        /**
         * Initialize class structures, read database
         * @returns {Promise<void>}
         */
        init(): Promise<void>;
        /**
         * Save accumulated changed fields, if any
         * @param {Object} options
         * @param {"REPLACE"|"INSERT"} options.behavior - if "REPLACE", does "REPLACE INTO".
         * 	"INSERT" forces to try inserting the record, regardless of _locateField
         * 	existance.
         */
        commit(options?: CommitOptions): Promise<void>;
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
        _init(options: any): Promise<void>;
        /**
         * Reads values from the database, puts them into _raw and creates a function
         * to get each value, so we can access fields as:
         * obj.field();
         * obj.field("new value");
         * @protected
         * @param {*} locateValue - the database unique id of the record
         * @param {String} byKey - the field to search on. $_locateField by default.
         */
        _read(locateValue: string | number | Date, byKey?: any): Promise<void>;
        /**
         * Does the same work as _read, but accepts the secondary keys and values arrays
         * @param keys {Array}
         * @param values {Array}
         * @private
         */
        _readByKey(keys: any, values: any): Promise<void>;
        /**
         * Initialize object and methods			if(args.Length >= 1 && !UUID.TryParse(args[0], out folder)) {
                    return "FAIL: error parsing folder UUID";
                }
         from rows array
         * @param rows
         * @private
         */
        _createFromRows(rows: any): void;
        /**
         * Initializes an empty object
         * @private
         */
        _initEmpty(): Promise<void>;
        /**
         * The template for access methods. Reads or sets the value of the object field.
         * @param field
         * @param value
         * @private
         */
        _accessField(field: any, value: any): any;
        /**
         * Creates a function within this class to get/set the certain field
         * @param field
         * @private
         */
        _createAccessMethod(field: any): void;
        /**
         * Removes the record from the database. No verification or integrity checks
         * are being performed, they are up to caller.
         */
        deleteRecord(): Promise<void>;
        /**
         * Starts a transaction and creates an instance of our object within that
         * transaction, passing it to the callback
         * @param {Function} cb - function to run with a "me" newly created objec
         * @returns {Promise<void>}
         */
        transactionWithMe(cb: any): Promise<void>;
        /**
         * Returns MysqlDatabase class used for this DbRecord object
         * @private
         */
        _getDbhClass(): any;
    }>;
    /** Creates a new database record, populating it from the fields list
     * @param {Object} fields
     * @param {Object} [options] - options for database creation
     * @returns {DbRecord} the newly created object
     */
    newRecord(fields: any, options?: {}): Promise<{
        _dbh: MysqlDatabase2;
        _raw: object;
        _changes: object;
        _super: object;
        _options: DbRecordOptions;
        _tableName: string;
        _locateField: string;
        /**
         * Initialize class structures, read database
         * @returns {Promise<void>}
         */
        init(): Promise<void>;
        /**
         * Save accumulated changed fields, if any
         * @param {Object} options
         * @param {"REPLACE"|"INSERT"} options.behavior - if "REPLACE", does "REPLACE INTO".
         * 	"INSERT" forces to try inserting the record, regardless of _locateField
         * 	existance.
         */
        commit(options?: CommitOptions): Promise<void>;
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
        _init(options: any): Promise<void>;
        /**
         * Reads values from the database, puts them into _raw and creates a function
         * to get each value, so we can access fields as:
         * obj.field();
         * obj.field("new value");
         * @protected
         * @param {*} locateValue - the database unique id of the record
         * @param {String} byKey - the field to search on. $_locateField by default.
         */
        _read(locateValue: string | number | Date, byKey?: any): Promise<void>;
        /**
         * Does the same work as _read, but accepts the secondary keys and values arrays
         * @param keys {Array}
         * @param values {Array}
         * @private
         */
        _readByKey(keys: any, values: any): Promise<void>;
        /**
         * Initialize object and methods			if(args.Length >= 1 && !UUID.TryParse(args[0], out folder)) {
                    return "FAIL: error parsing folder UUID";
                }
         from rows array
         * @param rows
         * @private
         */
        _createFromRows(rows: any): void;
        /**
         * Initializes an empty object
         * @private
         */
        _initEmpty(): Promise<void>;
        /**
         * The template for access methods. Reads or sets the value of the object field.
         * @param field
         * @param value
         * @private
         */
        _accessField(field: any, value: any): any;
        /**
         * Creates a function within this class to get/set the certain field
         * @param field
         * @private
         */
        _createAccessMethod(field: any): void;
        /**
         * Removes the record from the database. No verification or integrity checks
         * are being performed, they are up to caller.
         */
        deleteRecord(): Promise<void>;
        /**
         * Starts a transaction and creates an instance of our object within that
         * transaction, passing it to the callback
         * @param {Function} cb - function to run with a "me" newly created objec
         * @returns {Promise<void>}
         */
        transactionWithMe(cb: any): Promise<void>;
        /**
         * Returns MysqlDatabase class used for this DbRecord object
         * @private
         */
        _getDbhClass(): any;
    }>;
    /**
     * Returns master database handle currently in-use. To be used in static
     * methods of DbRecord
     *
     * @returns {MysqlDatabase2} current mysql database connection class
     */
    masterDbh(): Promise<MysqlDatabase2>;
    /**
     * Runs through database objects according the options, and calls the
     * callback routine for each.
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
    forEach(options: any, cb: any): Promise<any>;
    /**
     * Prepares SQL and param arrays for forEach()
     * @param options
     * @param where
     * @param qparam
     * @returns {string}
     * @private
     */
    _prepareForEach(options: any, where: any, qparam: any): string;
    /**
     * Returns MysqlDatabase class used for this DbRecord class
     * @private
     */
    _getDbhClassStatic(): typeof MysqlDatabase2;
};
/**
 * Represents the database record class.
**/
export = _default;

import MysqlDatabase2 from "./MysqlDatabase2";
declare type TransactionCallback<T extends DbRecord2> = (me: T) => Promise<boolean> | Promise<void> | boolean | void;
interface ChangedFields {
    [key: string]: boolean;
}
/**
 * Represents the database record class.
**/
declare class DbRecord2 {
    _dbh: MysqlDatabase2;
    _raw: DbRecord2.ObjectInitializer;
    _changes: ChangedFields;
    /** To hold the existing access method functions */
    _super: object;
    /** Initial values of the object */
    _values: DbRecord2.ObjectInitializer;
    /** Object creation options */
    _initOptions: DbRecord2.InitializerOptions;
    _tableName: string;
    _locateField: string;
    _keysList: string[];
    _dbObjectExists: boolean;
    static _table(): string;
    static _locatefield(): string;
    static _keys(): string[];
    /**
     * Creates the class instance. If options.${_locatefield()} parameter is specified,
     * reads the data from the database and put them into the internal structures
     * (see _init() and _read())
     * @param {Object} [values]
     * @param {Object} [initOptions]
     * @param {Boolean} [initOptions.forUpdate] - read record with FOR UPDATE flag,
     * 	blocking it within the transaction
     */
    constructor(values?: DbRecord2.ObjectInitializer, initOptions?: DbRecord2.InitializerOptions);
    /**
     * Initialize class structures, read database
     * @returns {Promise<void>}
     */
    init(): Promise<void>;
    /**
     * Tries creating an object by locate field/keys. Unlike constructor, does
     * not throw an error for non-existing record and returns null instead.
     * @param values
     * @param options
     */
    static tryCreate<T extends DbRecord2>(this: {
        new ({}: {}, {}: {}): T;
    }, values?: DbRecord2.ObjectInitializer, options?: DbRecord2.InitializerOptions): Promise<T>;
    /** Creates a new database record, populating it from the fields list
     * @param {Object} fields
     * @param {Object} [options] - options for database creation
     * @returns {DbRecord} the newly created object
     */
    static newRecord(fields: DbRecord2.ObjectInitializer): Promise<DbRecord2>;
    /**
     * Save accumulated changed fields, if any
     * @param {Object} options
     * @param {"REPLACE"|"INSERT"} options.behavior - if "REPLACE", does "REPLACE INTO".
     * 	"INSERT" forces to try inserting the record, regardless of _locateField
     * 	existance.
     */
    commit(options?: DbRecord2.CommitOptions): Promise<void>;
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
    _init(): Promise<void>;
    /**
     * Reads values from the database, puts them into _raw and creates a function
     * to get each value, so we can access fields as:
     * obj.field();
     * obj.field("new value");
     * @protected
     * @param {*} locateValue - the database unique id of the record
     * @param {String} byKey - the field to search on. $_locateField by default.
     */
    _read(locateValue: MysqlDatabase2.FieldValue, byKey?: string): Promise<void>;
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
    _accessField(field: string, value: DbRecord2.DbField): string | number | Date;
    /**
     * Creates a function within this class to get/set the certain field
     * @param field
     * @private
     */
    _createAccessMethod(field: string): void;
    /**
     * Removes the record from the database. No verification or integrity checks
     * are being performed, they are up to caller.
     */
    deleteRecord(): Promise<void>;
    /**
     * Returns master database handle currently in-use. To be used in static
     * methods of DbRecord
     *
     * @returns {MysqlDatabase2} current mysql database connection class
     */
    static masterDbh(): Promise<MysqlDatabase2>;
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
    static forEach<T extends DbRecord2>(this: {
        new (): T;
    }, options: DbRecord2.ForEachOptions, cb: DbRecord2.ForeachCallback<T>): Promise<number>;
    /**
     * Prepares SQL and param arrays for forEach()
     * @param options
     * @param where
     * @param qparam
     * @returns {string}
     * @private
     */
    static _prepareForEach(options: DbRecord2.ForEachOptions, where: any, qparam: any): string;
    /**
     * Starts a transaction and creates an instance of our object within that
     * transaction, passing it to the callback
     * @param {Function} cb - function to run with a "me" newly created objec
     * @returns {Promise<void>}
     */
    transactionWithMe<T extends DbRecord2>(this: T, cb: TransactionCallback<T>): Promise<void>;
    /**
     * Returns MysqlDatabase class used for this DbRecord class
     * @private
     */
    static _getDbhClassStatic(): typeof MysqlDatabase2;
    /**
     * Returns MysqlDatabase class used for this DbRecord object
     * @private
     */
    _getDbhClass(): any;
}
declare namespace DbRecord2 {
    /**
     * Possible types of db fields
     */
    type DbField = string | number | Date;
    /**
     * Standard options to initialize record
     */
    interface InitializerOptions {
        dbh?: MysqlDatabase2;
        forUpdate?: boolean;
    }
    /**
     * Custom options to initialize record
     */
    interface ObjectInitializer {
        [key: string]: DbRecord2.DbField;
    }
    interface CommitOptions {
        behavior?: "INSERT" | "REPLACE";
    }
    interface ForEachOptions {
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
    type ForeachCallback<T> = (item: T, options: DbRecord2.ForEachOptions) => Promise<boolean | void>;
    /**
     * Field access function types
     */
    namespace Column {
        type String = (value?: string) => string;
        type Number = (value?: number) => number;
        type DateTime = (value?: Date) => Date;
        /** Acts like a string by default but can be set to specific string set */
        type Enum<T extends string = string> = (value?: T) => T;
        /** Acts like a string by default but can be set to specific string set */
        type Set<T extends string = string> = (value?: T) => T;
    }
    /**
     * Add value to mysql SET field
     * @param currentValue
     * @param newValue
     */
    function setFieldSet(currentValue: string, newValue: string): string;
    /**
     * Remove value from mysql SET field
     * @param currentValue
     * @param toRemove
     */
    function setFieldRemove(currentValue: string, toRemove: string): string;
    /**
     * Check if value in in mysql SET field
     * @param currentValue
     * @param toRemove
     */
    function setFieldCheck(currentValue: string, check: string): boolean;
}
export = DbRecord2;

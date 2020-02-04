import MysqlDatabase2 from "./MysqlDatabase2";
declare type TransactionCallback = (me: DbRecord2) => Promise<boolean>;
declare type ForeachCallback = (item: DbRecord2, options: DbRecord2.ForEachOptions) => Promise<void>;
/**
 * Represents the database record class.
**/
declare class DbRecord2 {
    _dbh: MysqlDatabase2;
    _raw: object;
    _changes: object;
    _super: object;
    _options: DbRecord2.ObjectInitializer;
    _tableName: string;
    _locateField: string;
    _keysList: string[];
    static _table(): string;
    static _locatefield(): string;
    static _keys(): string[];
    /**
     * Creates the class instance. If options.${_locatefield()} parameter is specified,
     * reads the data from the database and put them into the internal structures
     * (see _init() and _read())
     * @param {Object} [options]
     * @param {Boolean} [options.forUpdate] - read record with FOR UPDATE flag,
     * 	blocking it within the transaction
     */
    constructor(options?: DbRecord2.ObjectInitializer);
    /**
     * Initialize class structures, read database
     * @returns {Promise<void>}
     */
    init(): Promise<void>;
    /**
     * Tries creating an object by locate field/keys. Unlike constructor, does
     * not throw an error for non-existing record and returns null instead.
     * @param options
     */
    static tryCreate<T extends DbRecord2>(this: {
        new ({}: {}): T;
    }, options?: DbRecord2.ObjectInitializer): Promise<T>;
    /** Creates a new database record, populating it from the fields list
     * @param {Object} fields
     * @param {Object} [options] - options for database creation
     * @returns {DbRecord} the newly created object
     */
    static newRecord(fields: any, options?: {}): Promise<DbRecord2>;
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
    _read(locateValue: MysqlDatabase2.FieldValue, byKey?: any): Promise<void>;
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
    static forEach(options: DbRecord2.ForEachOptions, cb: ForeachCallback): Promise<number>;
    /**
     * Prepares SQL and param arrays for forEach()
     * @param options
     * @param where
     * @param qparam
     * @returns {string}
     * @private
     */
    static _prepareForEach(options: any, where: any, qparam: any): string;
    /**
     * Starts a transaction and creates an instance of our object within that
     * transaction, passing it to the callback
     * @param {Function} cb - function to run with a "me" newly created objec
     * @returns {Promise<void>}
     */
    transactionWithMe(cb: TransactionCallback): Promise<void>;
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
    export type DbField = string | number | Date;
    /**
     * Standard options to initialize record
     */
    interface GenericInitializer {
        dbh?: MysqlDatabase2;
        forUpdate?: boolean;
    }
    /**
     * Custom options to initialize record
     */
    interface TypedInitializer {
        [key: string]: DbRecord2.DbField;
    }
    /**
     * Custom options to initialize record
     */
    export type ObjectInitializer = GenericInitializer & TypedInitializer;
    export interface CommitOptions {
        behavior?: "INSERT" | "REPLACE";
    }
    export interface ForEachOptions {
        /**
         * Total objects in iteration
         */
        TOTAL: number;
        /**
         * Current object index in iteration
         */
        COUNTER: number;
        /**
         * Raw object fields if ordered by 'provideRaw'
         */
        raw?: object;
        /**
         * Don't create an object while calling callback
         */
        noObjectCreate?: boolean;
        /**
         * Provide the raw representation of the object
         */
        provideRaw?: boolean;
    }
    /**
     * Field access function types
     */
    export namespace Column {
        type String = (value?: string) => string;
        type Number = (value?: Number) => Number;
        type DateTime = (value?: Date) => Date;
    }
    /**
     * Add value to mysql SET field
     * @param currentValue
     * @param newValue
     */
    export function setFieldSet(currentValue: string, newValue: string): string;
    /**
     * Remove value from mysql SET field
     * @param currentValue
     * @param toRemove
     */
    export function setFieldRemove(currentValue: string, toRemove: string): string;
    /**
     * Check if value in in mysql SET field
     * @param currentValue
     * @param toRemove
     */
    export function setFieldCheck(currentValue: string, check: string): boolean;
    export {};
}
export = DbRecord2;

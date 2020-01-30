import * as mysql from 'mysql';
interface MysqlConfig {
    host: string;
    database: string;
    user: string;
    password: string;
    names?: string;
    debugSQL?: boolean;
    reuseConnection?: boolean;
    logger: {
        log: (...args: any[]) => void;
    };
}
interface TableRow {
    [key: string]: MysqlDatabase2.FieldValue;
}
interface QueryResult extends Array<TableRow> {
    length: number;
    insertId: number;
    forEach: ((cb: object) => void);
}
interface DbConnection extends mysql.Connection {
    _seq?: number;
}
/**
 * The database processing class.
 *
 * Transaction processing
 *
 * The problem is that all queries share the same mysql connection. Thus, even
 * if we have started the transaction, other queries can intervene within it.
 *
 * To avoid this, we create a separate connection when calling code starts
 * transaction. Then we return the new database handle ("transacted") to use,
 * and commit/rollback at the end.
 *
 * var dbh = dbh.beginTransaction(); // new dbh is created here
 * ....
 * dbh.commit();
 */
declare class MysqlDatabase2 {
    cid: string;
    _config: MysqlConfig;
    _db: DbConnection;
    _createdFromPool: boolean;
    _transacted: number;
    /**
     * config:
     * 	user, password, host - regular mysql connection settings
     * 	reuseConnection - during a transaction start, don't get a new connection
     * 	debugSQL - log all SQL queries (debug)
     * @param config
     */
    constructor(config: MysqlConfig);
    connect(): Promise<unknown>;
    disconnect(): void;
    closeAndExit(): void;
    query(query: string, values?: MysqlDatabase2.FieldValue[], cb?: mysql.queryCallback): mysql.Query;
    queryAsync(query: string, values?: MysqlDatabase2.FieldValue[]): Promise<QueryResult>;
    /**
     * A shortcut function to get a single rows without messing with row arrays
     *
     * @param query
     * @param values
     * @returns {Object} - the object with selected fields or {} of no rows found
     */
    getRow(query: any, values: any): Promise<TableRow>;
    /**
     * Begins the database transaction.
     *
     * Used _config:
     * 	reuseConnection - use the same connection (debug)
     *
     * @param {Function} cb - the callback to call. Should return 'false' if
     * 	transaction should be rolled back
     */
    execTransaction(cb: any): Promise<any>;
    execTransactionAsync(cb: any): Promise<any>;
    /**
     * Commits the current database transaction
     */
    commit(): Promise<void>;
    _commit(): Promise<void>;
    /**
     * Rolls back the current database transaction
     */
    rollback(): Promise<void>;
    _rollback(): Promise<void>;
    destroy(): void;
    removeHandlers(): void;
    _closeAndExit(): void;
    _debug(...args: any[]): void;
    /**
     * The connection configuration for masterDbh
     * @param config
     */
    static masterConfig(config: MysqlConfig): void;
    /**
     * The connection factory. Creates a global connection to be used by default.
     *
     * @param {Object} options - additional options to pass to master dbh creation
     * @returns {MysqlDatabase2} current mysql database connection class
     */
    static masterDbh(options?: MysqlConfig): Promise<MysqlDatabase2>;
    /**
     * The connection factory fast entry, without need to create an object
     * @returns {*}
     */
    static masterDbhRO(): any;
    static masterDbhDestroy(): void;
    /**
     * Setup the mysql connection pool. All further connectionswill be
     * taken from within this pool.
     *
     * config:
     * 	user, password, host - regular mysql connection settings
     * 	connectionLimit - the size of the connection pool. Pool is used only if poolSize > 0
     * @param config
     */
    static setupPool(config: any): void;
    static destroyPoll(): void;
}
declare namespace MysqlDatabase2 {
    interface DbConfig extends MysqlConfig {
    }
    type FieldValue = string | number | Date;
}
export = MysqlDatabase2;

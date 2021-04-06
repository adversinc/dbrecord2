"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
const merge_1 = __importDefault(require("lodash/merge"));
const mysql = __importStar(require("mysql"));
const cls_hooked_1 = __importDefault(require("cls-hooked"));
const fs_1 = __importDefault(require("fs"));
/**
 * The MySQL connection wrapper which provides the following features:
 * - "master" db connection factory function
 * - sync queries (using Future)
 * - async queries (using Promises - not tested yet)
 * - nested transactions support (in progress)
 * - connection pooling for transaction
 * - local context of "master" db connection inside the transaction
 *
 */
let masterConfig = null;
let masterDbh = null;
// Connection pool
// If connection pool has been set up, MysqlDatabase will pick connections from it
let connectionPool = null;
// Local dbh context for transaction. Each transaction generates its own local
// context with its own "current global" dbh.
// During the transactions start, the value is populated with a transaction
// dbh, so all upcoming masterDbh() calls return the dbh actual for this transaction.
let trxContext = cls_hooked_1.default.createNamespace('mysql-dbh');
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
class MysqlDatabase2 {
    /**
     * config:
     * 	user, password, host - regular mysql connection settings
     * 	reuseConnection - during a transaction start, don't get a new connection
     * 	debugSQL - log all SQL queries (debug)
     * @param config
     */
    constructor(config) {
        this._db = null;
        this._createdFromPool = false;
        this._transacted = 0;
        this._config = merge_1.default({}, config);
        if (!connectionPool) {
            this._db = mysql.createConnection(this._config);
        }
    }
    connect() {
        return new Promise((resolve, reject) => {
            if (connectionPool) {
                connectionPool.getConnection((err, dbh) => {
                    // console.log("connection taken from pool");
                    this._createdFromPool = true;
                    this._db = dbh;
                    this.cid = Math.ceil(Math.random() * 1000000) + "p";
                    // SQL logging
                    if (this._config.debugSQL) {
                        if (!this._db._seq) {
                            this._db._seq = Math.ceil(Math.random() * 100000);
                        }
                        this._db.on('enqueue', function (sequence) {
                            console.log("QUERY (" + this._seq + "): ", sequence.sql);
                        });
                    }
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            }
            else {
                this.cid = Math.ceil(Math.random() * 1000000) + "s";
                this._db.connect((err) => {
                    if (err) {
                        reject(err);
                    }
                    if (this._config.names) {
                        this.query(`SET NAMES "${this._config.names}"`);
                    }
                    resolve();
                });
            }
        });
    }
    disconnect() {
        //if(TARGET == "development") {
        //	console.log(`${this._db.threadId}: closing mysql threadId`);
        //}
        this._db.end();
    }
    closeAndExit() {
        //trxDb.destroy();
        setTimeout(() => { process.exit(); }, 500);
    }
    query(query, values, cb) {
        return this._db.query(query, values, cb);
    }
    /**
     * Execute asyncronous query
     * @param query
     * @param values
     */
    queryAsync(query, values) {
        return new Promise((resolve, reject) => {
            this.query(query, values, (err, res) => {
                if (err) {
                    return reject(err);
                }
                // console.log("before resolve of", query, res);
                resolve(res);
            });
        });
    }
    /**
     * A shortcut function to get a single rows without messing with row arrays
     *
     * @param query
     * @param values
     * @returns {Object} - the object with selected fields or {} of no rows found
     */
    async getRow(query, values) {
        const rows = await this.queryAsync(query, values);
        // It is questionable: should we return {} or null below? Which is easier to use?
        // {} seems to be safer to use, no null.field error will fire
        if (rows.length === 0) {
            return {};
        }
        return rows[0];
    }
    /**
     * Begins the database transaction.
     *
     * Used _config:
     * 	reuseConnection - use the same connection (debug)
     *
     * @param {Function} cb - the callback to call. Should return 'false' if
     * 	transaction should be rolled back
     */
    async execTransaction(cb) {
        return this.execTransactionAsync(cb);
    }
    async execTransactionAsync(cb, callStack) {
        // TODO GG: port the nested trasactions code here
        let trxDb = null;
        // Set _config.reuseConnection=true to debug transaction run on the same connection
        if (this._transacted > 0 || this._config.reuseConnection) {
            // In a nested transaction, don't create a new connection
            trxDb = this;
            this._debug("reused dbh", trxDb.cid, this._transacted, this._config.reuseConnection);
        }
        else {
            /*
            if(TARGET === "development") {
                console.log(`Old ${this._db.threadId} is creating transaction connection`);
            }
            */
            trxDb = new this.constructor(this._config);
            trxDb._transacted = this._transacted;
            await trxDb.connect();
            this._debug("created transaction dbh", trxDb.cid);
        }
        // Only execute START TRANSACTION for the first-level trx
        const threadId = trxDb._db.threadId;
        if (trxDb._transacted++ === 0) {
            if (MysqlDatabase2.debugLogTransactions) {
                const stackTrace = Error().stack.replace("Error:", "Stack trace:");
                MysqlDatabase2.logTransaction(threadId, `\ntransaction starting:\n${stackTrace}`);
            }
            await trxDb.queryAsync("START TRANSACTION  /* from trx */");
            this._debug("START TRANSACTION in dbh", trxDb.cid);
        }
        MysqlDatabase2.logTransaction(threadId, `transaction level: ${trxDb._transacted}`);
        const trxPromise = new Promise((resolve, reject) => {
            // Execute transaction and create a running context for it
            trxContext.run(async () => {
                trxContext.set("dbh", trxDb);
                let res = false;
                try {
                    res = await cb(trxDb);
                    this._debug("got cb reply:", res);
                }
                catch (ex) {
                    this._debug("Internal transaction exception:", ex);
                    await trxDb._rollback();
                    MysqlDatabase2.logTransaction(threadId, `transaction rolled back in exception (level: ${trxDb._transacted})`);
                    reject(ex);
                }
                if (res === false) {
                    await trxDb._rollback();
                    MysqlDatabase2.logTransaction(threadId, `transaction rolled back (level: ${trxDb._transacted})`);
                    this._debug("did the rollback, dbh", this.cid);
                }
                else {
                    await trxDb._commit();
                    MysqlDatabase2.logTransaction(threadId, `transaction commit (level: ${trxDb._transacted})`);
                    this._debug("did the commit");
                }
                if (trxDb._transacted == 0) {
                    MysqlDatabase2.logTransaction(threadId, `TRANSACTION CLOSED\n`);
                }
                resolve();
            });
        });
        // Wait for transaction user function to finish
        // (trxContext.run does not support asyncs thus exists immediately)
        await trxPromise;
        // If we created a new connection, destroy it
        if (trxDb != this) {
            trxDb.destroy();
        }
        return trxDb;
    }
    static logTransaction(threadId, msg) {
        if (MysqlDatabase2.debugLogTransactions) {
            let newLine = "";
            if (msg.startsWith("\n")) {
                newLine = "\n";
                msg = msg.substr(1);
            }
            fs_1.default.appendFileSync(`/tmp/mysql-trx/${threadId}`, `[${new Date().toISOString()}] ${msg}\n`);
        }
    }
    /**
     * Commits the current database transaction
     */
    commit() {
        return this._commit();
    }
    async _commit() {
        if (this._transacted > 0) {
            this._transacted--;
            if (this._transacted === 0) {
                await this.queryAsync("COMMIT /* from trx */");
            }
        }
    }
    /**
     * Rolls back the current database transaction
     */
    rollback() {
        return this._rollback();
    }
    async _rollback() {
        if (this._transacted > 0) {
            this._transacted--;
            if (this._transacted === 0) {
                await this.queryAsync("ROLLBACK");
            }
        }
    }
    destroy() {
        // Connections created from pool are to be released, direct connections destroyed
        if (this._createdFromPool) {
            if (this._db != null) {
                this._db.release();
            }
        }
        else {
            this._db.destroy();
        }
        this.removeHandlers();
    }
    removeHandlers() {
        process.removeListener('SIGTERM', this._closeAndExit);
        process.removeListener('SIGINT', this._closeAndExit);
    }
    _closeAndExit() {
        setTimeout(() => { process.exit(); }, 500);
    }
    _debug(...args) {
        if (this._config.logger) {
            this._config.logger.log(...args);
        }
    }
    /**
     * The connection configuration for masterDbh
     * @param config
     */
    static masterConfig(config) {
        masterConfig = config;
    }
    /**
     * The connection factory. Creates a global connection to be used by default.
     *
     * @param {Object} options - additional options to pass to master dbh creation
     * @returns {MysqlDatabase2} current mysql database connection class
     */
    static masterDbh(options) {
        return new Promise((resolve, reject) => {
            // First try to get the local scope dbh of the current transaction
            const trxDbh = trxContext.get("dbh");
            if (trxDbh) {
                resolve(trxDbh);
            }
            // If no global dbh exist, create it
            if (!masterDbh) {
                const opt = Object.assign({}, masterConfig, options);
                masterDbh = new this(opt);
                masterDbh
                    .connect()
                    .then((r) => { resolve(masterDbh); })
                    .catch((err) => { reject(err); });
            }
            else {
                resolve(masterDbh);
            }
        });
    }
    /**
     * The connection factory fast entry, without need to create an object
     * @returns {*}
     */
    static masterDbhRO() {
        return trxContext.get("dbh");
    }
    static masterDbhDestroy() {
        if (masterDbh) {
            masterDbh.destroy();
            masterDbh = null;
        }
        this.destroyPoll();
    }
    /**
     * Setup the mysql connection pool. All further connectionswill be
     * taken from within this pool.
     *
     * config:
     * 	user, password, host - regular mysql connection settings
     * 	connectionLimit - the size of the connection pool. Pool is used only if poolSize > 0
     * @param config
     */
    static setupPool(config) {
        this.masterConfig(config);
        connectionPool = mysql.createPool(config);
        connectionPool.on('connection', (connection) => {
            if (config.names) {
                connection.query(`SET NAMES "${config.names}"`);
            }
        });
    }
    static destroyPoll() {
        if (connectionPool) {
            connectionPool.end((err) => {
                // console.log("connectionPool destroyed");
                connectionPool = null;
            });
        }
    }
}
// Set to true to log all transactions to file
MysqlDatabase2.debugLogTransactions = false;
(function (MysqlDatabase2) {
    ;
})(MysqlDatabase2 || (MysqlDatabase2 = {}));
module.exports = MysqlDatabase2;

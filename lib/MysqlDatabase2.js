"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _merge = _interopRequireDefault(require("lodash/merge"));

var _mysql = _interopRequireDefault(require("mysql"));

var _continuationLocalStorage = _interopRequireDefault(require("continuation-local-storage"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

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
let masterConfig = {};
let masterDbh = null; // Connection pool
// If connection pool has been set up, MysqlDatabase will pick connections from it

let connectionPool = null; // Local dbh context for transaction. Each transaction generates its own local
// context with its own "current global" dbh.
// During the transactions start, the value is populated with a transaction
// dbh, so all upcoming masterDbh() calls return the dbh actual for this transaction.

let trxContext = _continuationLocalStorage.default.createNamespace('mysql-dbh');
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
    this._config = (0, _merge.default)({}, config);
    this._db = null;
    this._createdFromPool = false;

    if (!connectionPool) {
      this._db = _mysql.default.createConnection(this._config);
    }

    this._transacted = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (connectionPool) {
        connectionPool.getConnection((err, dbh) => {
          // console.log("connection taken from pool");
          this._createdFromPool = true;
          this._db = dbh;
          this.cid = parseInt(Math.random() * 1000000) + "p"; // SQL logging

          if (this._config.debugSQL) {
            if (!this._db._seq) {
              this._db._seq = parseInt(Math.random() * 100000);
            }

            this._db.on('enqueue', function (sequence) {
              console.log("QUERY (" + this._seq + "): ", sequence.sql);
            });
          }

          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        this.cid = parseInt(Math.random() * 1000000) + "s";

        this._db.connect(res => {
          resolve(res);
        });
      }
    });
  }

  disconnect() {
    this._db.end();
  }

  closeAndExit() {
    trxDb.destroy();
    setTimeout(() => {
      process.exit();
    }, 500);
  }

  query(query, values, cb) {
    return this._db.query(query, values, cb);
  }

  queryAsync(query, values) {
    return new Promise((resolve, reject) => {
      this.query(query, values, (err, res) => {
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
    const rows = await this.queryAsync(query, values); // It is questionable: should we return {} or null below? Which is easier to use?
    // {} seems to be safer to use, no null.field error will fire

    if (rows.length === 0) {
      return {};
    }

    return rows[0];
  }
  /**
   * Begins the database transaction.
   *
   * @typedef {Object} ExecTransactionOptions
   */


  async execTransaction(cb) {
    // TODO GG: port the nested trasactions code here
    let trxDb = null; // Set _config.reuseConnection=true to debug transaction run on the same connection

    if (this._transacted > 0 || this._config.reuseConnection) {
      // In a nested transaction, don't create a new connection
      trxDb = this;

      this._debug("reused dbh", trxDb.cid, this._transacted, this._config.reuseConnection);
    } else {
      // console.log("Creating transaction connection");
      trxDb = new MysqlDatabase2(this._config);
      trxDb._transacted = this._transacted;
      await trxDb.connect();

      this._debug("created dbh", trxDb.cid);
    } // Only execute START TRANSACTION for the first-level trx


    if (trxDb._transacted++ === 0) {
      await trxDb.queryAsync("START TRANSACTION  /* from trx */");

      this._debug("START TRANSACTION in dbh", this.cid);
    }

    const trxPromise = new Promise((resolve, reject) => {
      // Execute transaction and create a running context for it
      trxContext.run(async () => {
        trxContext.set("dbh", trxDb);
        let res = false;

        try {
          res = await cb(trxDb);

          this._debug("got cb reply:", res);
        } catch (ex) {
          this._debug("Internal transaction exception:", ex);

          await trxDb.rollback();
          reject(ex);
        }

        if (res === false) {
          await trxDb.rollback();

          this._debug("did the rollback, dbh", this.cid);
        } else {
          await trxDb.commit();

          this._debug("did the commit");
        }

        resolve();
      });
    }); // Wait for transaction user function to finish
    // (trxContext.run does not support asyncs thus exists immediately)

    await trxPromise; // If we created a new connection, destroy it

    if (trxDb != this) {
      trxDb.destroy();
    }

    return trxDb;
  }
  /**
   * Commits the current database transaction
   */


  async commit() {
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


  async rollback() {
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
      this._db.release();
    } else {
      this._db.destroy();
    }

    this.removeHandlers();
  }

  removeHandlers() {
    process.removeListener('SIGTERM', this._closeAndExit);
    process.removeListener('SIGINT', this._closeAndExit);
  }

  _closeAndExit() {
    setTimeout(() => {
      process.exit();
    }, 500);
  }

  _debug() {
    if (this._config.logger) {
      this._config.logger.log(...arguments);
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


  static masterDbh(options = {}) {
    return new Promise((resolve, reject) => {
      // First try to get the local scope dbh of the current transaction
      const trxDbh = trxContext.get("dbh");

      if (trxDbh) {
        resolve(trxDbh);
      } // If no global dbh exist, create it


      if (!masterDbh) {
        const opt = Object.assign({}, masterConfig, options);
        masterDbh = new MysqlDatabase2(opt);
        masterDbh.connect().then(() => {
          resolve(masterDbh);
        });
      } else {
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
    connectionPool = _mysql.default.createPool(config);
  }

  static destroyPoll() {
    if (connectionPool) {
      connectionPool.end(err => {// console.log("connectionPool destroyed");
      });
    }
  }

}

var _default = MysqlDatabase2;
exports.default = _default;
module.exports = exports.default;
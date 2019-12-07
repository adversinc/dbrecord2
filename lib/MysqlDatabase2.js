"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _merge = _interopRequireDefault(require("lodash/merge"));

var _mysql = _interopRequireDefault(require("mysql"));

var _clsHooked = _interopRequireDefault(require("cls-hooked"));

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

let trxContext = _clsHooked.default.createNamespace('mysql-dbh');
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

        this._db.connect(err => {
          if (err) {
            reject(err);
          }

          resolve();
        });
      }
    });
  }

  disconnect() {
    console.log(`${this._db.threadId}: closing mysql threadId`);

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
        if (err) {
          return reject(err);
        } // console.log("before resolve of", query, res);


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
   * Used _config:
   * 	reuseConnection - use the same connection (debug)
   *
   * @param {Function} cb - the callback to call. Should return 'false' if
   * 	transaction should be rolled back
   */


  async execTransaction(cb) {
    return this.execTransactionAsync(cb);
  }

  async execTransactionAsync(cb) {
    // TODO GG: port the nested trasactions code here
    let trxDb = null; // Set _config.reuseConnection=true to debug transaction run on the same connection

    if (this._transacted > 0 || this._config.reuseConnection) {
      // In a nested transaction, don't create a new connection
      trxDb = this;

      this._debug("reused dbh", trxDb.cid, this._transacted, this._config.reuseConnection);
    } else {
      console.log(`Old ${this._db.threadId} is creating transaction connection`);
      trxDb = new this.constructor(this._config);
      trxDb._transacted = this._transacted;
      await trxDb.connect();

      this._debug("created transaction dbh", trxDb.cid);
    } // Only execute START TRANSACTION for the first-level trx


    if (trxDb._transacted++ === 0) {
      await trxDb.queryAsync("START TRANSACTION  /* from trx */");

      this._debug("START TRANSACTION in dbh", trxDb.cid);
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

          await trxDb._rollback();
          reject(ex);
        }

        if (res === false) {
          await trxDb._rollback();

          this._debug("did the rollback, dbh", this.cid);
        } else {
          await trxDb._commit();

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
        masterDbh = new this(opt);
        masterDbh.connect().then(r => {
          resolve(masterDbh);
        }).catch(err => {
          reject(err);
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
      connectionPool.end(err => {
        // console.log("connectionPool destroyed");
        connectionPool = null;
      });
    }
  }

}

var _default = MysqlDatabase2;
exports.default = _default;
module.exports = exports.default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9NeXNxbERhdGFiYXNlMi5qcyJdLCJuYW1lcyI6WyJtYXN0ZXJDb25maWciLCJtYXN0ZXJEYmgiLCJjb25uZWN0aW9uUG9vbCIsInRyeENvbnRleHQiLCJDb250ZXh0U3RvcmFnZSIsImNyZWF0ZU5hbWVzcGFjZSIsIk15c3FsRGF0YWJhc2UyIiwiY29uc3RydWN0b3IiLCJjb25maWciLCJfY29uZmlnIiwiX2RiIiwiX2NyZWF0ZWRGcm9tUG9vbCIsIm15c3FsIiwiY3JlYXRlQ29ubmVjdGlvbiIsIl90cmFuc2FjdGVkIiwiY29ubmVjdCIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwiZ2V0Q29ubmVjdGlvbiIsImVyciIsImRiaCIsImNpZCIsInBhcnNlSW50IiwiTWF0aCIsInJhbmRvbSIsImRlYnVnU1FMIiwiX3NlcSIsIm9uIiwic2VxdWVuY2UiLCJjb25zb2xlIiwibG9nIiwic3FsIiwiZGlzY29ubmVjdCIsInRocmVhZElkIiwiZW5kIiwiY2xvc2VBbmRFeGl0IiwidHJ4RGIiLCJkZXN0cm95Iiwic2V0VGltZW91dCIsInByb2Nlc3MiLCJleGl0IiwicXVlcnkiLCJ2YWx1ZXMiLCJjYiIsInF1ZXJ5QXN5bmMiLCJyZXMiLCJnZXRSb3ciLCJyb3dzIiwibGVuZ3RoIiwiZXhlY1RyYW5zYWN0aW9uIiwiZXhlY1RyYW5zYWN0aW9uQXN5bmMiLCJyZXVzZUNvbm5lY3Rpb24iLCJfZGVidWciLCJ0cnhQcm9taXNlIiwicnVuIiwic2V0IiwiZXgiLCJfcm9sbGJhY2siLCJfY29tbWl0IiwiY29tbWl0Iiwicm9sbGJhY2siLCJyZWxlYXNlIiwicmVtb3ZlSGFuZGxlcnMiLCJyZW1vdmVMaXN0ZW5lciIsIl9jbG9zZUFuZEV4aXQiLCJsb2dnZXIiLCJhcmd1bWVudHMiLCJvcHRpb25zIiwidHJ4RGJoIiwiZ2V0Iiwib3B0IiwiT2JqZWN0IiwiYXNzaWduIiwidGhlbiIsInIiLCJjYXRjaCIsIm1hc3RlckRiaFJPIiwibWFzdGVyRGJoRGVz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Ozs7QUFTQSxTQUFPQyxTQUFQLENBQWlCeEUsTUFBakIsRUFBeUI7QUFDeEIsU0FBS1IsWUFBTCxDQUFrQlEsTUFBbEI7QUFDQU4sSUFBQUEsY0FBYyxHQUFHVSxlQUFNcUUsVUFBTixDQUFpQnpFLE1BQWpCLENBQWpCO0FBQ0E7O0FBRUQsU0FBT3VFLFdBQVAsR0FBcUI7QUFDcEIsUUFBRzdFLGNBQUgsRUFBbUI7QUFDbEJBLE1BQUFBLGNBQWMsQ0FBQ2lDLEdBQWYsQ0FBb0JmLEdBQUQsSUFBUztBQUMzQjtBQUNBbEIsUUFBQUEsY0FBYyxHQUFHLElBQWpCO0FBQ0EsT0FIRDtBQUlBO0FBQ0Q7O0FBN1RtQjs7ZUFpVU5JLGMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgbG9kYXNoTWVyZ2UgZnJvbSAnbG9kYXNoL21lcmdlJztcbmltcG9ydCBteXNxbCBmcm9tICdteXNxbCc7XG5pbXBvcnQgQ29udGV4dFN0b3JhZ2UgZnJvbSAnY2xzLWhvb2tlZCc7XG5cbi8qKlxuICogVGhlIE15U1FMIGNvbm5lY3Rpb24gd3JhcHBlciB3aGljaCBwcm92aWRlcyB0aGUgZm9sbG93aW5nIGZlYXR1cmVzOlxuICogLSBcIm1hc3RlclwiIGRiIGNvbm5lY3Rpb24gZmFjdG9yeSBmdW5jdGlvblxuICogLSBzeW5jIHF1ZXJpZXMgKHVzaW5nIEZ1dHVyZSlcbiAqIC0gYXN5bmMgcXVlcmllcyAodXNpbmcgUHJvbWlzZXMgLSBub3QgdGVzdGVkIHlldClcbiAqIC0gbmVzdGVkIHRyYW5zYWN0aW9ucyBzdXBwb3J0IChpbiBwcm9ncmVzcylcbiAqIC0gY29ubmVjdGlvbiBwb29saW5nIGZvciB0cmFuc2FjdGlvblxuICogLSBsb2NhbCBjb250ZXh0IG9mIFwibWFzdGVyXCIgZGIgY29ubmVjdGlvbiBpbnNpZGUgdGhlIHRyYW5zYWN0aW9uXG4gKlxuICovXG5cbmxldCBtYXN0ZXJDb25maWcgPSB7fTtcbmxldCBtYXN0ZXJEYmggPSBudWxsO1xuXG4vLyBDb25uZWN0aW9uIHBvb2xcbi8vIElmIGNvbm5lY3Rpb24gcG9vbCBoYXMgYmVlbiBzZXQgdXAsIE15c3FsRGF0YWJhc2Ugd2lsbCBwaWNrIGNvbm5lY3Rpb25zIGZyb20gaXRcbmxldCBjb25uZWN0aW9uUG9vbCA9IG51bGw7XG5cbi8vIExvY2FsIGRiaCBjb250ZXh0IGZvciB0cmFuc2FjdGlvbi4gRWFjaCB0cmFuc2FjdGlvbiBnZW5lcmF0ZXMgaXRzIG93biBsb2NhbFxuLy8gY29udGV4dCB3aXRoIGl0cyBvd24gXCJjdXJyZW50IGdsb2JhbFwiIGRiaC5cbi8vIER1cmluZyB0aGUgdHJhbnNhY3Rpb25zIHN0YXJ0LCB0aGUgdmFsdWUgaXMgcG9wdWxhdGVkIHdpdGggYSB0cmFuc2FjdGlvblxuLy8gZGJoLCBzbyBhbGwgdXBjb21pbmcgbWFzdGVyRGJoKCkgY2FsbHMgcmV0dXJuIHRoZSBkYmggYWN0dWFsIGZvciB0aGlzIHRyYW5zYWN0aW9uLlxubGV0IHRyeENvbnRleHQgPSBDb250ZXh0U3RvcmFnZS5jcmVhdGVOYW1lc3BhY2UoJ215c3FsLWRiaCcpO1xuXG4vKipcbiAqIFRoZSBkYXRhYmFzZSBwcm9jZXNzaW5nIGNsYXNzLlxuICpcbiAqIFRyYW5zYWN0aW9uIHByb2Nlc3NpbmdcbiAqXG4gKiBUaGUgcHJvYmxlbSBpcyB0aGF0IGFsbCBxdWVyaWVzIHNoYXJlIHRoZSBzYW1lIG15c3FsIGNvbm5lY3Rpb24uIFRodXMsIGV2ZW5cbiAqIGlmIHdlIGhhdmUgc3RhcnRlZCB0aGUgdHJhbnNhY3Rpb24sIG90aGVyIHF1ZXJpZXMgY2FuIGludGVydmVuZSB3aXRoaW4gaXQuXG4gKlxuICogVG8gYXZvaWQgdGhpcywgd2UgY3JlYXRlIGEgc2VwYXJhdGUgY29ubmVjdGlvbiB3aGVuIGNhbGxpbmcgY29kZSBzdGFydHNcbiAqIHRyYW5zYWN0aW9uLiBUaGVuIHdlIHJldHVybiB0aGUgbmV3IGRhdGFiYXNlIGhhbmRsZSAoXCJ0cmFuc2FjdGVkXCIpIHRvIHVzZSxcbiAqIGFuZCBjb21taXQvcm9sbGJhY2sgYXQgdGhlIGVuZC5cbiAqXG4gKiB2YXIgZGJoID0gZGJoLmJlZ2luVHJhbnNhY3Rpb24oKTsgLy8gbmV3IGRiaCBpcyBjcmVhdGVkIGhlcmVcbiAqIC4uLi5cbiAqIGRiaC5jb21taXQoKTtcbiAqL1xuY2xhc3MgTXlzcWxEYXRhYmFzZTIge1xuXHQvKipcblx0ICogY29uZmlnOlxuXHQgKiBcdHVzZXIsIHBhc3N3b3JkLCBob3N0IC0gcmVndWxhciBteXNxbCBjb25uZWN0aW9uIHNldHRpbmdzXG5cdCAqIFx0cmV1c2VDb25uZWN0aW9uIC0gZHVyaW5nIGEgdHJhbnNhY3Rpb24gc3RhcnQsIGRvbid0IGdldCBhIG5ldyBjb25uZWN0aW9uXG5cdCAqIFx0ZGVidWdTUUwgLSBsb2cgYWxsIFNRTCBxdWVyaWVzIChkZWJ1Zylcblx0ICogQHBhcmFtIGNvbmZpZ1xuXHQgKi9cblx0Y29uc3RydWN0b3IoY29uZmlnKSB7XG5cdFx0dGhpcy5fY29uZmlnID0gbG9kYXNoTWVyZ2Uoe30sIGNvbmZpZyk7XG5cblx0XHR0aGlzLl9kYiA9IG51bGw7XG5cdFx0dGhpcy5fY3JlYXRlZEZyb21Qb29sID0gZmFsc2U7XG5cdFx0aWYoIWNvbm5lY3Rpb25Qb29sKSB7XG5cdFx0XHR0aGlzLl9kYiA9IG15c3FsLmNyZWF0ZUNvbm5lY3Rpb24odGhpcy5fY29uZmlnKTtcblx0XHR9XG5cblx0XHR0aGlzLl90cmFuc2FjdGVkID0gMDtcblx0fVxuXG5cdGNvbm5lY3QoKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGlmKGNvbm5lY3Rpb25Qb29sKSB7XG5cdFx0XHRcdGNvbm5lY3Rpb25Qb29sLmdldENvbm5lY3Rpb24oKGVyciwgZGJoKSA9PiB7XG5cdFx0XHRcdFx0Ly8gY29uc29sZS5sb2coXCJjb25uZWN0aW9uIHRha2VuIGZyb20gcG9vbFwiKTtcblx0XHRcdFx0XHR0aGlzLl9jcmVhdGVkRnJvbVBvb2wgPSB0cnVlO1xuXHRcdFx0XHRcdHRoaXMuX2RiID0gZGJoO1xuXHRcdFx0XHRcdHRoaXMuY2lkID0gcGFyc2VJbnQoTWF0aC5yYW5kb20oKSAqIDEwMDAwMDApICsgXCJwXCI7XG5cblx0XHRcdFx0XHQvLyBTUUwgbG9nZ2luZ1xuXHRcdFx0XHRcdGlmKHRoaXMuX2NvbmZpZy5kZWJ1Z1NRTCkge1xuXHRcdFx0XHRcdFx0aWYoIXRoaXMuX2RiLl9zZXEpIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5fZGIuX3NlcSA9IHBhcnNlSW50KE1hdGgucmFuZG9tKCkgKiAxMDAwMDApO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHR0aGlzLl9kYi5vbignZW5xdWV1ZScsIGZ1bmN0aW9uKHNlcXVlbmNlKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKFwiUVVFUlkgKFwiICsgdGhpcy5fc2VxICsgXCIpOiBcIiwgc2VxdWVuY2Uuc3FsKTtcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmKGVycikge1xuXHRcdFx0XHRcdFx0cmVqZWN0KGVycik7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5jaWQgPSBwYXJzZUludChNYXRoLnJhbmRvbSgpICogMTAwMDAwMCkgKyBcInNcIjtcblxuXHRcdFx0XHR0aGlzLl9kYi5jb25uZWN0KChlcnIpID0+IHtcblx0XHRcdFx0XHRpZihlcnIpIHsgcmVqZWN0KGVycik7IH1cblx0XHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdH0pO1xuXHR9XG5cblxuXHRkaXNjb25uZWN0KCkge1xuXHRcdGlmKFRBUkdFVCA9PSBcImRldmVsb3BtZW50XCIpIHtcblx0XHRcdGNvbnNvbGUubG9nKGAke3RoaXMuX2RiLnRocmVhZElkfTogY2xvc2luZyBteXNxbCB0aHJlYWRJZGApO1xuXHRcdH1cblxuXHRcdHRoaXMuX2RiLmVuZCgpO1xuXHR9XG5cblx0Y2xvc2VBbmRFeGl0KCkge1xuXHRcdHRyeERiLmRlc3Ryb3koKTtcblx0XHRzZXRUaW1lb3V0KCgpID0+IHsgcHJvY2Vzcy5leGl0KCk7IH0sIDUwMCk7XG5cdH1cblxuXHRxdWVyeShxdWVyeSwgdmFsdWVzLCBjYikge1xuXHRcdHJldHVybiB0aGlzLl9kYi5xdWVyeShxdWVyeSwgdmFsdWVzLCBjYik7XG5cdH1cblxuXHRxdWVyeUFzeW5jKHF1ZXJ5LCB2YWx1ZXMpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0dGhpcy5xdWVyeShxdWVyeSwgdmFsdWVzLCAoZXJyLCByZXMpID0+IHtcblx0XHRcdFx0aWYoZXJyKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHJlamVjdChlcnIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIGNvbnNvbGUubG9nKFwiYmVmb3JlIHJlc29sdmUgb2ZcIiwgcXVlcnksIHJlcyk7XG5cdFx0XHRcdHJlc29sdmUocmVzKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEEgc2hvcnRjdXQgZnVuY3Rpb24gdG8gZ2V0IGEgc2luZ2xlIHJvd3Mgd2l0aG91dCBtZXNzaW5nIHdpdGggcm93IGFycmF5c1xuXHQgKlxuXHQgKiBAcGFyYW0gcXVlcnlcblx0ICogQHBhcmFtIHZhbHVlc1xuXHQgKiBAcmV0dXJucyB7T2JqZWN0fSAtIHRoZSBvYmplY3Qgd2l0aCBzZWxlY3RlZCBmaWVsZHMgb3Ige30gb2Ygbm8gcm93cyBmb3VuZFxuXHQgKi9cblx0YXN5bmMgZ2V0Um93KHF1ZXJ5LCB2YWx1ZXMpIHtcblx0XHRjb25zdCByb3dzID0gYXdhaXQgdGhpcy5xdWVyeUFzeW5jKHF1ZXJ5LCB2YWx1ZXMpO1xuXHRcdC8vIEl0IGlzIHF1ZXN0aW9uYWJsZTogc2hvdWxkIHdlIHJldHVybiB7fSBvciBudWxsIGJlbG93PyBXaGljaCBpcyBlYXNpZXIgdG8gdXNlP1xuXHRcdC8vIHt9IHNlZW1zIHRvIGJlIHNhZmVyIHRvIHVzZSwgbm8gbnVsbC5maWVsZCBlcnJvciB3aWxsIGZpcmVcblx0XHRpZihyb3dzLmxlbmd0aCA9PT0gMCkgeyByZXR1cm4ge307IH1cblxuXHRcdHJldHVybiByb3dzWzBdO1xuXHR9XG5cblx0LyoqXG5cdCAqIEJlZ2lucyB0aGUgZGF0YWJhc2UgdHJhbnNhY3Rpb24uXG5cdCAqXG5cdCAqIFVzZWQgX2NvbmZpZzpcblx0ICogXHRyZXVzZUNvbm5lY3Rpb24gLSB1c2UgdGhlIHNhbWUgY29ubmVjdGlvbiAoZGVidWcpXG5cdCAqXG5cdCAqIEBwYXJhbSB7RnVuY3Rpb259IGNiIC0gdGhlIGNhbGxiYWNrIHRvIGNhbGwuIFNob3VsZCByZXR1cm4gJ2ZhbHNlJyBpZlxuXHQgKiBcdHRyYW5zYWN0aW9uIHNob3VsZCBiZSByb2xsZWQgYmFja1xuXHQgKi9cblx0YXN5bmMgZXhlY1RyYW5zYWN0aW9uKGNiKSB7XG5cdFx0cmV0dXJuIHRoaXMuZXhlY1RyYW5zYWN0aW9uQXN5bmMoY2IpO1xuXHR9XG5cblx0YXN5bmMgZXhlY1RyYW5zYWN0aW9uQXN5bmMoY2IpIHtcblx0XHQvLyBUT0RPIEdHOiBwb3J0IHRoZSBuZXN0ZWQgdHJhc2FjdGlvbnMgY29kZSBoZXJlXG5cdFx0bGV0IHRyeERiID0gbnVsbDtcblxuXHRcdC8vIFNldCBfY29uZmlnLnJldXNlQ29ubmVjdGlvbj10cnVlIHRvIGRlYnVnIHRyYW5zYWN0aW9uIHJ1biBvbiB0aGUgc2FtZSBjb25uZWN0aW9uXG5cdFx0aWYodGhpcy5fdHJhbnNhY3RlZCA+IDAgfHwgdGhpcy5fY29uZmlnLnJldXNlQ29ubmVjdGlvbikge1xuXHRcdFx0Ly8gSW4gYSBuZXN0ZWQgdHJhbnNhY3Rpb24sIGRvbid0IGNyZWF0ZSBhIG5ldyBjb25uZWN0aW9uXG5cdFx0XHR0cnhEYiA9IHRoaXM7XG5cdFx0XHR0aGlzLl9kZWJ1ZyhcInJldXNlZCBkYmhcIiwgdHJ4RGIuY2lkLCB0aGlzLl90cmFuc2FjdGVkLCB0aGlzLl9jb25maWcucmV1c2VDb25uZWN0aW9uKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0aWYoVEFSR0VUID09PSBcImRldmVsb3BtZW50XCIpIHtcblx0XHRcdFx0Y29uc29sZS5sb2coYE9sZCAke3RoaXMuX2RiLnRocmVhZElkfSBpcyBjcmVhdGluZyB0cmFuc2FjdGlvbiBjb25uZWN0aW9uYCk7XG5cdFx0XHR9XG5cblx0XHRcdHRyeERiID0gbmV3IHRoaXMuY29uc3RydWN0b3IodGhpcy5fY29uZmlnKTtcblx0XHRcdHRyeERiLl90cmFuc2FjdGVkID0gdGhpcy5fdHJhbnNhY3RlZDtcblxuXHRcdFx0YXdhaXQgdHJ4RGIuY29ubmVjdCgpO1xuXHRcdFx0dGhpcy5fZGVidWcoXCJjcmVhdGVkIHRyYW5zYWN0aW9uIGRiaFwiLCB0cnhEYi5jaWQpO1xuXHRcdH1cblxuXHRcdC8vIE9ubHkgZXhlY3V0ZSBTVEFSVCBUUkFOU0FDVElPTiBmb3IgdGhlIGZpcnN0LWxldmVsIHRyeFxuXHRcdGlmKHRyeERiLl90cmFuc2FjdGVkKysgPT09IDApIHtcblx0XHRcdGF3YWl0IHRyeERiLnF1ZXJ5QXN5bmMoXCJTVEFSVCBUUkFOU0FDVElPTiAgLyogZnJvbSB0cnggKi9cIik7XG5cdFx0XHR0aGlzLl9kZWJ1ZyhcIlNUQVJUIFRSQU5TQUNUSU9OIGluIGRiaFwiLCB0cnhEYi5jaWQpO1xuXHRcdH1cblx0XHRjb25zdCB0cnhQcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0Ly8gRXhlY3V0ZSB0cmFuc2FjdGlvbiBhbmQgY3JlYXRlIGEgcnVubmluZyBjb250ZXh0IGZvciBpdFxuXHRcdFx0dHJ4Q29udGV4dC5ydW4oYXN5bmMoKSA9PiB7XG5cdFx0XHRcdHRyeENvbnRleHQuc2V0KFwiZGJoXCIsIHRyeERiKTtcblxuXHRcdFx0XHRsZXQgcmVzID0gZmFsc2U7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0cmVzID0gYXdhaXQgY2IodHJ4RGIpO1xuXHRcdFx0XHRcdHRoaXMuX2RlYnVnKFwiZ290IGNiIHJlcGx5OlwiLCByZXMpO1xuXHRcdFx0XHR9IGNhdGNoKGV4KSB7XG5cdFx0XHRcdFx0dGhpcy5fZGVidWcoXCJJbnRlcm5hbCB0cmFuc2FjdGlvbiBleGNlcHRpb246XCIsIGV4KTtcblx0XHRcdFx0XHRhd2FpdCB0cnhEYi5fcm9sbGJhY2soKTtcblx0XHRcdFx0XHRyZWplY3QoZXgpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYocmVzID09PSBmYWxzZSkge1xuXHRcdFx0XHRcdGF3YWl0IHRyeERiLl9yb2xsYmFjaygpO1xuXHRcdFx0XHRcdHRoaXMuX2RlYnVnKFwiZGlkIHRoZSByb2xsYmFjaywgZGJoXCIsIHRoaXMuY2lkKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRhd2FpdCB0cnhEYi5fY29tbWl0KCk7XG5cdFx0XHRcdFx0dGhpcy5fZGVidWcoXCJkaWQgdGhlIGNvbW1pdFwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0Ly8gV2FpdCBmb3IgdHJhbnNhY3Rpb24gdXNlciBmdW5jdGlvbiB0byBmaW5pc2hcblx0XHQvLyAodHJ4Q29udGV4dC5ydW4gZG9lcyBub3Qgc3VwcG9ydCBhc3luY3MgdGh1cyBleGlzdHMgaW1tZWRpYXRlbHkpXG5cdFx0YXdhaXQgdHJ4UHJvbWlzZTtcblxuXHRcdC8vIElmIHdlIGNyZWF0ZWQgYSBuZXcgY29ubmVjdGlvbiwgZGVzdHJveSBpdFxuXHRcdGlmKHRyeERiICE9IHRoaXMpIHtcblx0XHRcdHRyeERiLmRlc3Ryb3koKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gdHJ4RGI7XG5cdH1cblxuXHQvKipcblx0ICogQ29tbWl0cyB0aGUgY3VycmVudCBkYXRhYmFzZSB0cmFuc2FjdGlvblxuXHQgKi9cblx0Y29tbWl0KCkge1xuXHRcdHJldHVybiB0aGlzLl9jb21taXQoKTtcblx0fVxuXG5cdGFzeW5jIF9jb21taXQoKSB7XG5cdFx0aWYodGhpcy5fdHJhbnNhY3RlZCA+IDApIHtcblx0XHRcdHRoaXMuX3RyYW5zYWN0ZWQtLTtcblxuXHRcdFx0aWYodGhpcy5fdHJhbnNhY3RlZCA9PT0gMCkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnF1ZXJ5QXN5bmMoXCJDT01NSVQgLyogZnJvbSB0cnggKi9cIik7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFJvbGxzIGJhY2sgdGhlIGN1cnJlbnQgZGF0YWJhc2UgdHJhbnNhY3Rpb25cblx0ICovXG5cdHJvbGxiYWNrKCkge1xuXHRcdHJldHVybiB0aGlzLl9yb2xsYmFjaygpO1xuXHR9XG5cblx0YXN5bmMgX3JvbGxiYWNrKCkge1xuXHRcdGlmKHRoaXMuX3RyYW5zYWN0ZWQgPiAwKSB7XG5cdFx0XHR0aGlzLl90cmFuc2FjdGVkLS07XG5cblx0XHRcdGlmKHRoaXMuX3RyYW5zYWN0ZWQgPT09IDApIHtcblx0XHRcdFx0YXdhaXQgdGhpcy5xdWVyeUFzeW5jKFwiUk9MTEJBQ0tcIik7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0ZGVzdHJveSgpIHtcblx0XHQvLyBDb25uZWN0aW9ucyBjcmVhdGVkIGZyb20gcG9vbCBhcmUgdG8gYmUgcmVsZWFzZWQsIGRpcmVjdCBjb25uZWN0aW9ucyBkZXN0cm95ZWRcblx0XHRpZih0aGlzLl9jcmVhdGVkRnJvbVBvb2wpIHtcblx0XHRcdGlmKHRoaXMuX2RiICE9IG51bGwpIHsgdGhpcy5fZGIucmVsZWFzZSgpOyB9XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuX2RiLmRlc3Ryb3koKTtcblx0XHR9XG5cblx0XHR0aGlzLnJlbW92ZUhhbmRsZXJzKCk7XG5cdH1cblxuXHRyZW1vdmVIYW5kbGVycygpIHtcblx0XHRwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdURVJNJywgdGhpcy5fY2xvc2VBbmRFeGl0KTtcblx0XHRwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdJTlQnLCB0aGlzLl9jbG9zZUFuZEV4aXQpO1xuXHR9XG5cblx0X2Nsb3NlQW5kRXhpdCgpIHtcblx0XHRzZXRUaW1lb3V0KCgpID0+IHsgcHJvY2Vzcy5leGl0KCk7IH0sIDUwMCk7XG5cdH1cblxuXHRfZGVidWcoKSB7XG5cdFx0aWYodGhpcy5fY29uZmlnLmxvZ2dlcikge1xuXHRcdFx0dGhpcy5fY29uZmlnLmxvZ2dlci5sb2coLi4uYXJndW1lbnRzKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogVGhlIGNvbm5lY3Rpb24gY29uZmlndXJhdGlvbiBmb3IgbWFzdGVyRGJoXG5cdCAqIEBwYXJhbSBjb25maWdcblx0ICovXG5cdHN0YXRpYyBtYXN0ZXJDb25maWcoY29uZmlnKSB7XG5cdFx0bWFzdGVyQ29uZmlnID0gY29uZmlnO1xuXHR9XG5cblx0LyoqXG5cdCAqIFRoZSBjb25uZWN0aW9uIGZhY3RvcnkuIENyZWF0ZXMgYSBnbG9iYWwgY29ubmVjdGlvbiB0byBiZSB1c2VkIGJ5IGRlZmF1bHQuXG5cdCAqXG5cdCAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIC0gYWRkaXRpb25hbCBvcHRpb25zIHRvIHBhc3MgdG8gbWFzdGVyIGRiaCBjcmVhdGlvblxuXHQgKiBAcmV0dXJucyB7TXlzcWxEYXRhYmFzZTJ9IGN1cnJlbnQgbXlzcWwgZGF0YWJhc2UgY29ubmVjdGlvbiBjbGFzc1xuXHQgKi9cblx0c3RhdGljIG1hc3RlckRiaChvcHRpb25zID0ge30pIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0Ly8gRmlyc3QgdHJ5IHRvIGdldCB0aGUgbG9jYWwgc2NvcGUgZGJoIG9mIHRoZSBjdXJyZW50IHRyYW5zYWN0aW9uXG5cdFx0XHRjb25zdCB0cnhEYmggPSB0cnhDb250ZXh0LmdldChcImRiaFwiKTtcblx0XHRcdGlmKHRyeERiaCkge1xuXHRcdFx0XHRyZXNvbHZlKHRyeERiaCk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIElmIG5vIGdsb2JhbCBkYmggZXhpc3QsIGNyZWF0ZSBpdFxuXHRcdFx0aWYoIW1hc3RlckRiaCkge1xuXHRcdFx0XHRjb25zdCBvcHQgPSBPYmplY3QuYXNzaWduKHt9LCBtYXN0ZXJDb25maWcsIG9wdGlvbnMpO1xuXHRcdFx0XHRtYXN0ZXJEYmggPSBuZXcgdGhpcyhvcHQpO1xuXG5cdFx0XHRcdG1hc3RlckRiaFxuXHRcdFx0XHRcdC5jb25uZWN0KClcblx0XHRcdFx0XHQudGhlbigocikgPT4geyByZXNvbHZlKG1hc3RlckRiaCk7IH0pXG5cdFx0XHRcdFx0LmNhdGNoKChlcnIpID0+IHsgcmVqZWN0KGVycik7IH0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0cmVzb2x2ZShtYXN0ZXJEYmgpO1xuXHRcdFx0fVxuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFRoZSBjb25uZWN0aW9uIGZhY3RvcnkgZmFzdCBlbnRyeSwgd2l0aG91dCBuZWVkIHRvIGNyZWF0ZSBhbiBvYmplY3Rcblx0ICogQHJldHVybnMgeyp9XG5cdCAqL1xuXHRzdGF0aWMgbWFzdGVyRGJoUk8oKSB7XG5cdFx0cmV0dXJuIHRyeENvbnRleHQuZ2V0KFwiZGJoXCIpO1xuXHR9XG5cblxuXHRzdGF0aWMgbWFzdGVyRGJoRGVzdHJveSgpIHtcblx0XHRpZihtYXN0ZXJEYmgpIHtcblx0XHRcdG1hc3RlckRiaC5kZXN0cm95KCk7XG5cdFx0XHRtYXN0ZXJEYmggPSBudWxsO1xuXHRcdH1cblxuXHRcdHRoaXMuZGVzdHJveVBvbGwoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXR1cCB0aGUgbXlzcWwgY29ubmVjdGlvbiBwb29sLiBBbGwgZnVydGhlciBjb25uZWN0aW9uc3dpbGwgYmVcblx0ICogdGFrZW4gZnJvbSB3aXRoaW4gdGhpcyBwb29sLlxuXHQgKlxuXHQgKiBjb25maWc6XG5cdCAqIFx0dXNlciwgcGFzc3dvcmQsIGhvc3QgLSByZWd1bGFyIG15c3FsIGNvbm5lY3Rpb24gc2V0dGluZ3Ncblx0ICogXHRjb25uZWN0aW9uTGltaXQgLSB0aGUgc2l6ZSBvZiB0aGUgY29ubmVjdGlvbiBwb29sLiBQb29sIGlzIHVzZWQgb25seSBpZiBwb29sU2l6ZSA+IDBcblx0ICogQHBhcmFtIGNvbmZpZ1xuXHQgKi9cblx0c3RhdGljIHNldHVwUG9vbChjb25maWcpIHtcblx0XHR0aGlzLm1hc3RlckNvbmZpZyhjb25maWcpO1xuXHRcdGNvbm5lY3Rpb25Qb29sID0gbXlzcWwuY3JlYXRlUG9vbChjb25maWcpO1xuXHR9XG5cblx0c3RhdGljIGRlc3Ryb3lQb2xsKCkge1xuXHRcdGlmKGNvbm5lY3Rpb25Qb29sKSB7XG5cdFx0XHRjb25uZWN0aW9uUG9vbC5lbmQoKGVycikgPT4ge1xuXHRcdFx0XHQvLyBjb25zb2xlLmxvZyhcImNvbm5lY3Rpb25Qb29sIGRlc3Ryb3llZFwiKTtcblx0XHRcdFx0Y29ubmVjdGlvblBvb2wgPSBudWxsO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG59XG5cblxuZXhwb3J0IGRlZmF1bHQgTXlzcWxEYXRhYmFzZTI7XG5cbiJdfQ==
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9NeXNxbERhdGFiYXNlMi5qcyJdLCJuYW1lcyI6WyJtYXN0ZXJDb25maWciLCJtYXN0ZXJEYmgiLCJjb25uZWN0aW9uUG9vbCIsInRyeENvbnRleHQiLCJDb250ZXh0U3RvcmFnZSIsImNyZWF0ZU5hbWVzcGFjZSIsIk15c3FsRGF0YWJhc2UyIiwiY29uc3RydWN0b3IiLCJjb25maWciLCJfY29uZmlnIiwiX2RiIiwiX2NyZWF0ZWRGcm9tUG9vbCIsIm15c3FsIiwiY3JlYXRlQ29ubmVjdGlvbiIsIl90cmFuc2FjdGVkIiwiY29ubmVjdCIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwiZ2V0Q29ubmVjdGlvbiIsImVyciIsImRiaCIsImNpZCIsInBhcnNlSW50IiwiTWF0aCIsInJhbmRvbSIsImRlYnVnU1FMIiwiX3NlcSIsIm9uIiwic2VxdWVuY2UiLCJjb25zb2xlIiwibG9nIiwic3FsIiwiZGlzY29ubmVjdCIsImVuZCIsImNsb3NlQW5kRXhpdCIsInRyeERiIiwiZGVzdHJveSIsInNldFRpbWVvdXQiLCJwcm9jZXNzIiwiZXhpdCIsInF1ZXJ5IiwidmFsdWVzIiwiY2IiLCJxdWVyeUFzeW5jIiwicmVzIiwiZ2V0Um93Iiwicm93cyIsImxlbmd0aCIsImV4ZWNUcmFuc2FjdGlvbiIsImV4ZWNUcmFuc2FjdGlvbkFzeW5jIiwicmV1c2VDb25uZWN0aW9uIiwiX2RlYnVnIiwidHJ4UHJvbWlzZSIsInJ1biIsInNldCIsImV4IiwiX3JvbGxiYWNrIiwiX2NvbW1pdCIsImNvbW1pdCIsInJvbGxiYWNrIiwicmVsZWFzZSIsInJlbW92ZUhhbmRsZXJzIiwicmVtb3ZlTGlzdGVuZXIiLCJfY2xvc2VBbmRFeGl0IiwibG9nZ2VyIiwiYXJndW1lbnRzIiwib3B0aW9ucyIsInRyeERiaCIsImdldCIsIm9wdCIsIk9iamVjdCIsImFzc2lnbiIsInRoZW4iLCJyIiwiY2F0Y2giLCJtYXN0ZXJEYmhSTyIsIm1hc3RlckRiaERlc3Ryb3kiLCJkZXN0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QjtBQUNwQixRQUFHNUUsY0FBSCxFQUFtQjtBQUNsQkEsTUFBQUEsY0FBYyxDQUFDZ0MsR0FBZixDQUFvQmQsR0FBRCxJQUFTO0FBQzNCO0FBQ0FsQixRQUFBQSxjQUFjLEdBQUcsSUFBakI7QUFDQSxPQUhEO0FBSUE7QUFDRDs7QUE3VG1COztlQWlVTkksYyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBsb2Rhc2hNZXJnZSBmcm9tICdsb2Rhc2gvbWVyZ2UnO1xuaW1wb3J0IG15c3FsIGZyb20gJ215c3FsJztcbmltcG9ydCBDb250ZXh0U3RvcmFnZSBmcm9tICdjbHMtaG9va2VkJztcblxuLyoqXG4gKiBUaGUgTXlTUUwgY29ubmVjdGlvbiB3cmFwcGVyIHdoaWNoIHByb3ZpZGVzIHRoZSBmb2xsb3dpbmcgZmVhdHVyZXM6XG4gKiAtIFwibWFzdGVyXCIgZGIgY29ubmVjdGlvbiBmYWN0b3J5IGZ1bmN0aW9uXG4gKiAtIHN5bmMgcXVlcmllcyAodXNpbmcgRnV0dXJlKVxuICogLSBhc3luYyBxdWVyaWVzICh1c2luZyBQcm9taXNlcyAtIG5vdCB0ZXN0ZWQgeWV0KVxuICogLSBuZXN0ZWQgdHJhbnNhY3Rpb25zIHN1cHBvcnQgKGluIHByb2dyZXNzKVxuICogLSBjb25uZWN0aW9uIHBvb2xpbmcgZm9yIHRyYW5zYWN0aW9uXG4gKiAtIGxvY2FsIGNvbnRleHQgb2YgXCJtYXN0ZXJcIiBkYiBjb25uZWN0aW9uIGluc2lkZSB0aGUgdHJhbnNhY3Rpb25cbiAqXG4gKi9cblxubGV0IG1hc3RlckNvbmZpZyA9IHt9O1xubGV0IG1hc3RlckRiaCA9IG51bGw7XG5cbi8vIENvbm5lY3Rpb24gcG9vbFxuLy8gSWYgY29ubmVjdGlvbiBwb29sIGhhcyBiZWVuIHNldCB1cCwgTXlzcWxEYXRhYmFzZSB3aWxsIHBpY2sgY29ubmVjdGlvbnMgZnJvbSBpdFxubGV0IGNvbm5lY3Rpb25Qb29sID0gbnVsbDtcblxuLy8gTG9jYWwgZGJoIGNvbnRleHQgZm9yIHRyYW5zYWN0aW9uLiBFYWNoIHRyYW5zYWN0aW9uIGdlbmVyYXRlcyBpdHMgb3duIGxvY2FsXG4vLyBjb250ZXh0IHdpdGggaXRzIG93biBcImN1cnJlbnQgZ2xvYmFsXCIgZGJoLlxuLy8gRHVyaW5nIHRoZSB0cmFuc2FjdGlvbnMgc3RhcnQsIHRoZSB2YWx1ZSBpcyBwb3B1bGF0ZWQgd2l0aCBhIHRyYW5zYWN0aW9uXG4vLyBkYmgsIHNvIGFsbCB1cGNvbWluZyBtYXN0ZXJEYmgoKSBjYWxscyByZXR1cm4gdGhlIGRiaCBhY3R1YWwgZm9yIHRoaXMgdHJhbnNhY3Rpb24uXG5sZXQgdHJ4Q29udGV4dCA9IENvbnRleHRTdG9yYWdlLmNyZWF0ZU5hbWVzcGFjZSgnbXlzcWwtZGJoJyk7XG5cbi8qKlxuICogVGhlIGRhdGFiYXNlIHByb2Nlc3NpbmcgY2xhc3MuXG4gKlxuICogVHJhbnNhY3Rpb24gcHJvY2Vzc2luZ1xuICpcbiAqIFRoZSBwcm9ibGVtIGlzIHRoYXQgYWxsIHF1ZXJpZXMgc2hhcmUgdGhlIHNhbWUgbXlzcWwgY29ubmVjdGlvbi4gVGh1cywgZXZlblxuICogaWYgd2UgaGF2ZSBzdGFydGVkIHRoZSB0cmFuc2FjdGlvbiwgb3RoZXIgcXVlcmllcyBjYW4gaW50ZXJ2ZW5lIHdpdGhpbiBpdC5cbiAqXG4gKiBUbyBhdm9pZCB0aGlzLCB3ZSBjcmVhdGUgYSBzZXBhcmF0ZSBjb25uZWN0aW9uIHdoZW4gY2FsbGluZyBjb2RlIHN0YXJ0c1xuICogdHJhbnNhY3Rpb24uIFRoZW4gd2UgcmV0dXJuIHRoZSBuZXcgZGF0YWJhc2UgaGFuZGxlIChcInRyYW5zYWN0ZWRcIikgdG8gdXNlLFxuICogYW5kIGNvbW1pdC9yb2xsYmFjayBhdCB0aGUgZW5kLlxuICpcbiAqIHZhciBkYmggPSBkYmguYmVnaW5UcmFuc2FjdGlvbigpOyAvLyBuZXcgZGJoIGlzIGNyZWF0ZWQgaGVyZVxuICogLi4uLlxuICogZGJoLmNvbW1pdCgpO1xuICovXG5jbGFzcyBNeXNxbERhdGFiYXNlMiB7XG5cdC8qKlxuXHQgKiBjb25maWc6XG5cdCAqIFx0dXNlciwgcGFzc3dvcmQsIGhvc3QgLSByZWd1bGFyIG15c3FsIGNvbm5lY3Rpb24gc2V0dGluZ3Ncblx0ICogXHRyZXVzZUNvbm5lY3Rpb24gLSBkdXJpbmcgYSB0cmFuc2FjdGlvbiBzdGFydCwgZG9uJ3QgZ2V0IGEgbmV3IGNvbm5lY3Rpb25cblx0ICogXHRkZWJ1Z1NRTCAtIGxvZyBhbGwgU1FMIHF1ZXJpZXMgKGRlYnVnKVxuXHQgKiBAcGFyYW0gY29uZmlnXG5cdCAqL1xuXHRjb25zdHJ1Y3Rvcihjb25maWcpIHtcblx0XHR0aGlzLl9jb25maWcgPSBsb2Rhc2hNZXJnZSh7fSwgY29uZmlnKTtcblxuXHRcdHRoaXMuX2RiID0gbnVsbDtcblx0XHR0aGlzLl9jcmVhdGVkRnJvbVBvb2wgPSBmYWxzZTtcblx0XHRpZighY29ubmVjdGlvblBvb2wpIHtcblx0XHRcdHRoaXMuX2RiID0gbXlzcWwuY3JlYXRlQ29ubmVjdGlvbih0aGlzLl9jb25maWcpO1xuXHRcdH1cblxuXHRcdHRoaXMuX3RyYW5zYWN0ZWQgPSAwO1xuXHR9XG5cblx0Y29ubmVjdCgpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0aWYoY29ubmVjdGlvblBvb2wpIHtcblx0XHRcdFx0Y29ubmVjdGlvblBvb2wuZ2V0Q29ubmVjdGlvbigoZXJyLCBkYmgpID0+IHtcblx0XHRcdFx0XHQvLyBjb25zb2xlLmxvZyhcImNvbm5lY3Rpb24gdGFrZW4gZnJvbSBwb29sXCIpO1xuXHRcdFx0XHRcdHRoaXMuX2NyZWF0ZWRGcm9tUG9vbCA9IHRydWU7XG5cdFx0XHRcdFx0dGhpcy5fZGIgPSBkYmg7XG5cdFx0XHRcdFx0dGhpcy5jaWQgPSBwYXJzZUludChNYXRoLnJhbmRvbSgpICogMTAwMDAwMCkgKyBcInBcIjtcblxuXHRcdFx0XHRcdC8vIFNRTCBsb2dnaW5nXG5cdFx0XHRcdFx0aWYodGhpcy5fY29uZmlnLmRlYnVnU1FMKSB7XG5cdFx0XHRcdFx0XHRpZighdGhpcy5fZGIuX3NlcSkge1xuXHRcdFx0XHRcdFx0XHR0aGlzLl9kYi5fc2VxID0gcGFyc2VJbnQoTWF0aC5yYW5kb20oKSAqIDEwMDAwMCk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdHRoaXMuX2RiLm9uKCdlbnF1ZXVlJywgZnVuY3Rpb24oc2VxdWVuY2UpIHtcblx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coXCJRVUVSWSAoXCIgKyB0aGlzLl9zZXEgKyBcIik6IFwiLCBzZXF1ZW5jZS5zcWwpO1xuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYoZXJyKSB7XG5cdFx0XHRcdFx0XHRyZWplY3QoZXJyKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmNpZCA9IHBhcnNlSW50KE1hdGgucmFuZG9tKCkgKiAxMDAwMDAwKSArIFwic1wiO1xuXG5cdFx0XHRcdHRoaXMuX2RiLmNvbm5lY3QoKGVycikgPT4ge1xuXHRcdFx0XHRcdGlmKGVycikgeyByZWplY3QoZXJyKTsgfVxuXHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH1cblxuXG5cdGRpc2Nvbm5lY3QoKSB7XG5cdFx0aWYoVEFSR0VUID09IFwiZGV2ZWxvcG1lbnRcIikge1xuXHRcdFx0Y29uc29sZS5sb2coYCR7dGhpcy5fZGIudGhyZWFkSWR9OiBjbG9zaW5nIG15c3FsIHRocmVhZElkYCk7XG5cdFx0fVxuXG5cdFx0dGhpcy5fZGIuZW5kKCk7XG5cdH1cblxuXHRjbG9zZUFuZEV4aXQoKSB7XG5cdFx0dHJ4RGIuZGVzdHJveSgpO1xuXHRcdHNldFRpbWVvdXQoKCkgPT4geyBwcm9jZXNzLmV4aXQoKTsgfSwgNTAwKTtcblx0fVxuXG5cdHF1ZXJ5KHF1ZXJ5LCB2YWx1ZXMsIGNiKSB7XG5cdFx0cmV0dXJuIHRoaXMuX2RiLnF1ZXJ5KHF1ZXJ5LCB2YWx1ZXMsIGNiKTtcblx0fVxuXG5cdHF1ZXJ5QXN5bmMocXVlcnksIHZhbHVlcykge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHR0aGlzLnF1ZXJ5KHF1ZXJ5LCB2YWx1ZXMsIChlcnIsIHJlcykgPT4ge1xuXHRcdFx0XHRpZihlcnIpIHtcblx0XHRcdFx0XHRyZXR1cm4gcmVqZWN0KGVycik7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gY29uc29sZS5sb2coXCJiZWZvcmUgcmVzb2x2ZSBvZlwiLCBxdWVyeSwgcmVzKTtcblx0XHRcdFx0cmVzb2x2ZShyZXMpO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogQSBzaG9ydGN1dCBmdW5jdGlvbiB0byBnZXQgYSBzaW5nbGUgcm93cyB3aXRob3V0IG1lc3Npbmcgd2l0aCByb3cgYXJyYXlzXG5cdCAqXG5cdCAqIEBwYXJhbSBxdWVyeVxuXHQgKiBAcGFyYW0gdmFsdWVzXG5cdCAqIEByZXR1cm5zIHtPYmplY3R9IC0gdGhlIG9iamVjdCB3aXRoIHNlbGVjdGVkIGZpZWxkcyBvciB7fSBvZiBubyByb3dzIGZvdW5kXG5cdCAqL1xuXHRhc3luYyBnZXRSb3cocXVlcnksIHZhbHVlcykge1xuXHRcdGNvbnN0IHJvd3MgPSBhd2FpdCB0aGlzLnF1ZXJ5QXN5bmMocXVlcnksIHZhbHVlcyk7XG5cdFx0Ly8gSXQgaXMgcXVlc3Rpb25hYmxlOiBzaG91bGQgd2UgcmV0dXJuIHt9IG9yIG51bGwgYmVsb3c/IFdoaWNoIGlzIGVhc2llciB0byB1c2U/XG5cdFx0Ly8ge30gc2VlbXMgdG8gYmUgc2FmZXIgdG8gdXNlLCBubyBudWxsLmZpZWxkIGVycm9yIHdpbGwgZmlyZVxuXHRcdGlmKHJvd3MubGVuZ3RoID09PSAwKSB7IHJldHVybiB7fTsgfVxuXG5cdFx0cmV0dXJuIHJvd3NbMF07XG5cdH1cblxuXHQvKipcblx0ICogQmVnaW5zIHRoZSBkYXRhYmFzZSB0cmFuc2FjdGlvbi5cblx0ICpcblx0ICogVXNlZCBfY29uZmlnOlxuXHQgKiBcdHJldXNlQ29ubmVjdGlvbiAtIHVzZSB0aGUgc2FtZSBjb25uZWN0aW9uIChkZWJ1Zylcblx0ICpcblx0ICogQHBhcmFtIHtGdW5jdGlvbn0gY2IgLSB0aGUgY2FsbGJhY2sgdG8gY2FsbC4gU2hvdWxkIHJldHVybiAnZmFsc2UnIGlmXG5cdCAqIFx0dHJhbnNhY3Rpb24gc2hvdWxkIGJlIHJvbGxlZCBiYWNrXG5cdCAqL1xuXHRhc3luYyBleGVjVHJhbnNhY3Rpb24oY2IpIHtcblx0XHRyZXR1cm4gdGhpcy5leGVjVHJhbnNhY3Rpb25Bc3luYyhjYik7XG5cdH1cblxuXHRhc3luYyBleGVjVHJhbnNhY3Rpb25Bc3luYyhjYikge1xuXHRcdC8vIFRPRE8gR0c6IHBvcnQgdGhlIG5lc3RlZCB0cmFzYWN0aW9ucyBjb2RlIGhlcmVcblx0XHRsZXQgdHJ4RGIgPSBudWxsO1xuXG5cdFx0Ly8gU2V0IF9jb25maWcucmV1c2VDb25uZWN0aW9uPXRydWUgdG8gZGVidWcgdHJhbnNhY3Rpb24gcnVuIG9uIHRoZSBzYW1lIGNvbm5lY3Rpb25cblx0XHRpZih0aGlzLl90cmFuc2FjdGVkID4gMCB8fCB0aGlzLl9jb25maWcucmV1c2VDb25uZWN0aW9uKSB7XG5cdFx0XHQvLyBJbiBhIG5lc3RlZCB0cmFuc2FjdGlvbiwgZG9uJ3QgY3JlYXRlIGEgbmV3IGNvbm5lY3Rpb25cblx0XHRcdHRyeERiID0gdGhpcztcblx0XHRcdHRoaXMuX2RlYnVnKFwicmV1c2VkIGRiaFwiLCB0cnhEYi5jaWQsIHRoaXMuX3RyYW5zYWN0ZWQsIHRoaXMuX2NvbmZpZy5yZXVzZUNvbm5lY3Rpb24pO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRpZihUQVJHRVQgPT09IFwiZGV2ZWxvcG1lbnRcIikge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgT2xkICR7dGhpcy5fZGIudGhyZWFkSWR9IGlzIGNyZWF0aW5nIHRyYW5zYWN0aW9uIGNvbm5lY3Rpb25gKTtcblx0XHRcdH1cblxuXHRcdFx0dHJ4RGIgPSBuZXcgdGhpcy5jb25zdHJ1Y3Rvcih0aGlzLl9jb25maWcpO1xuXHRcdFx0dHJ4RGIuX3RyYW5zYWN0ZWQgPSB0aGlzLl90cmFuc2FjdGVkO1xuXG5cdFx0XHRhd2FpdCB0cnhEYi5jb25uZWN0KCk7XG5cdFx0XHR0aGlzLl9kZWJ1ZyhcImNyZWF0ZWQgdHJhbnNhY3Rpb24gZGJoXCIsIHRyeERiLmNpZCk7XG5cdFx0fVxuXG5cdFx0Ly8gT25seSBleGVjdXRlIFNUQVJUIFRSQU5TQUNUSU9OIGZvciB0aGUgZmlyc3QtbGV2ZWwgdHJ4XG5cdFx0aWYodHJ4RGIuX3RyYW5zYWN0ZWQrKyA9PT0gMCkge1xuXHRcdFx0YXdhaXQgdHJ4RGIucXVlcnlBc3luYyhcIlNUQVJUIFRSQU5TQUNUSU9OICAvKiBmcm9tIHRyeCAqL1wiKTtcblx0XHRcdHRoaXMuX2RlYnVnKFwiU1RBUlQgVFJBTlNBQ1RJT04gaW4gZGJoXCIsIHRyeERiLmNpZCk7XG5cdFx0fVxuXHRcdGNvbnN0IHRyeFByb21pc2UgPSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHQvLyBFeGVjdXRlIHRyYW5zYWN0aW9uIGFuZCBjcmVhdGUgYSBydW5uaW5nIGNvbnRleHQgZm9yIGl0XG5cdFx0XHR0cnhDb250ZXh0LnJ1bihhc3luYygpID0+IHtcblx0XHRcdFx0dHJ4Q29udGV4dC5zZXQoXCJkYmhcIiwgdHJ4RGIpO1xuXG5cdFx0XHRcdGxldCByZXMgPSBmYWxzZTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRyZXMgPSBhd2FpdCBjYih0cnhEYik7XG5cdFx0XHRcdFx0dGhpcy5fZGVidWcoXCJnb3QgY2IgcmVwbHk6XCIsIHJlcyk7XG5cdFx0XHRcdH0gY2F0Y2goZXgpIHtcblx0XHRcdFx0XHR0aGlzLl9kZWJ1ZyhcIkludGVybmFsIHRyYW5zYWN0aW9uIGV4Y2VwdGlvbjpcIiwgZXgpO1xuXHRcdFx0XHRcdGF3YWl0IHRyeERiLl9yb2xsYmFjaygpO1xuXHRcdFx0XHRcdHJlamVjdChleCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZihyZXMgPT09IGZhbHNlKSB7XG5cdFx0XHRcdFx0YXdhaXQgdHJ4RGIuX3JvbGxiYWNrKCk7XG5cdFx0XHRcdFx0dGhpcy5fZGVidWcoXCJkaWQgdGhlIHJvbGxiYWNrLCBkYmhcIiwgdGhpcy5jaWQpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGF3YWl0IHRyeERiLl9jb21taXQoKTtcblx0XHRcdFx0XHR0aGlzLl9kZWJ1ZyhcImRpZCB0aGUgY29tbWl0XCIpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHQvLyBXYWl0IGZvciB0cmFuc2FjdGlvbiB1c2VyIGZ1bmN0aW9uIHRvIGZpbmlzaFxuXHRcdC8vICh0cnhDb250ZXh0LnJ1biBkb2VzIG5vdCBzdXBwb3J0IGFzeW5jcyB0aHVzIGV4aXN0cyBpbW1lZGlhdGVseSlcblx0XHRhd2FpdCB0cnhQcm9taXNlO1xuXG5cdFx0Ly8gSWYgd2UgY3JlYXRlZCBhIG5ldyBjb25uZWN0aW9uLCBkZXN0cm95IGl0XG5cdFx0aWYodHJ4RGIgIT0gdGhpcykge1xuXHRcdFx0dHJ4RGIuZGVzdHJveSgpO1xuXHRcdH1cblxuXHRcdHJldHVybiB0cnhEYjtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb21taXRzIHRoZSBjdXJyZW50IGRhdGFiYXNlIHRyYW5zYWN0aW9uXG5cdCAqL1xuXHRjb21taXQoKSB7XG5cdFx0cmV0dXJuIHRoaXMuX2NvbW1pdCgpO1xuXHR9XG5cblx0YXN5bmMgX2NvbW1pdCgpIHtcblx0XHRpZih0aGlzLl90cmFuc2FjdGVkID4gMCkge1xuXHRcdFx0dGhpcy5fdHJhbnNhY3RlZC0tO1xuXG5cdFx0XHRpZih0aGlzLl90cmFuc2FjdGVkID09PSAwKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMucXVlcnlBc3luYyhcIkNPTU1JVCAvKiBmcm9tIHRyeCAqL1wiKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogUm9sbHMgYmFjayB0aGUgY3VycmVudCBkYXRhYmFzZSB0cmFuc2FjdGlvblxuXHQgKi9cblx0cm9sbGJhY2soKSB7XG5cdFx0cmV0dXJuIHRoaXMuX3JvbGxiYWNrKCk7XG5cdH1cblxuXHRhc3luYyBfcm9sbGJhY2soKSB7XG5cdFx0aWYodGhpcy5fdHJhbnNhY3RlZCA+IDApIHtcblx0XHRcdHRoaXMuX3RyYW5zYWN0ZWQtLTtcblxuXHRcdFx0aWYodGhpcy5fdHJhbnNhY3RlZCA9PT0gMCkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnF1ZXJ5QXN5bmMoXCJST0xMQkFDS1wiKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRkZXN0cm95KCkge1xuXHRcdC8vIENvbm5lY3Rpb25zIGNyZWF0ZWQgZnJvbSBwb29sIGFyZSB0byBiZSByZWxlYXNlZCwgZGlyZWN0IGNvbm5lY3Rpb25zIGRlc3Ryb3llZFxuXHRcdGlmKHRoaXMuX2NyZWF0ZWRGcm9tUG9vbCkge1xuXHRcdFx0aWYodGhpcy5fZGIgIT0gbnVsbCkgeyB0aGlzLl9kYi5yZWxlYXNlKCk7IH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5fZGIuZGVzdHJveSgpO1xuXHRcdH1cblxuXHRcdHRoaXMucmVtb3ZlSGFuZGxlcnMoKTtcblx0fVxuXG5cdHJlbW92ZUhhbmRsZXJzKCkge1xuXHRcdHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoJ1NJR1RFUk0nLCB0aGlzLl9jbG9zZUFuZEV4aXQpO1xuXHRcdHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoJ1NJR0lOVCcsIHRoaXMuX2Nsb3NlQW5kRXhpdCk7XG5cdH1cblxuXHRfY2xvc2VBbmRFeGl0KCkge1xuXHRcdHNldFRpbWVvdXQoKCkgPT4geyBwcm9jZXNzLmV4aXQoKTsgfSwgNTAwKTtcblx0fVxuXG5cdF9kZWJ1ZygpIHtcblx0XHRpZih0aGlzLl9jb25maWcubG9nZ2VyKSB7XG5cdFx0XHR0aGlzLl9jb25maWcubG9nZ2VyLmxvZyguLi5hcmd1bWVudHMpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBUaGUgY29ubmVjdGlvbiBjb25maWd1cmF0aW9uIGZvciBtYXN0ZXJEYmhcblx0ICogQHBhcmFtIGNvbmZpZ1xuXHQgKi9cblx0c3RhdGljIG1hc3RlckNvbmZpZyhjb25maWcpIHtcblx0XHRtYXN0ZXJDb25maWcgPSBjb25maWc7XG5cdH1cblxuXHQvKipcblx0ICogVGhlIGNvbm5lY3Rpb24gZmFjdG9yeS4gQ3JlYXRlcyBhIGdsb2JhbCBjb25uZWN0aW9uIHRvIGJlIHVzZWQgYnkgZGVmYXVsdC5cblx0ICpcblx0ICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMgLSBhZGRpdGlvbmFsIG9wdGlvbnMgdG8gcGFzcyB0byBtYXN0ZXIgZGJoIGNyZWF0aW9uXG5cdCAqIEByZXR1cm5zIHtNeXNxbERhdGFiYXNlMn0gY3VycmVudCBteXNxbCBkYXRhYmFzZSBjb25uZWN0aW9uIGNsYXNzXG5cdCAqL1xuXHRzdGF0aWMgbWFzdGVyRGJoKG9wdGlvbnMgPSB7fSkge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHQvLyBGaXJzdCB0cnkgdG8gZ2V0IHRoZSBsb2NhbCBzY29wZSBkYmggb2YgdGhlIGN1cnJlbnQgdHJhbnNhY3Rpb25cblx0XHRcdGNvbnN0IHRyeERiaCA9IHRyeENvbnRleHQuZ2V0KFwiZGJoXCIpO1xuXHRcdFx0aWYodHJ4RGJoKSB7XG5cdFx0XHRcdHJlc29sdmUodHJ4RGJoKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gSWYgbm8gZ2xvYmFsIGRiaCBleGlzdCwgY3JlYXRlIGl0XG5cdFx0XHRpZighbWFzdGVyRGJoKSB7XG5cdFx0XHRcdGNvbnN0IG9wdCA9IE9iamVjdC5hc3NpZ24oe30sIG1hc3RlckNvbmZpZywgb3B0aW9ucyk7XG5cdFx0XHRcdG1hc3RlckRiaCA9IG5ldyB0aGlzKG9wdCk7XG5cblx0XHRcdFx0bWFzdGVyRGJoXG5cdFx0XHRcdFx0LmNvbm5lY3QoKVxuXHRcdFx0XHRcdC50aGVuKChyKSA9PiB7IHJlc29sdmUobWFzdGVyRGJoKTsgfSlcblx0XHRcdFx0XHQuY2F0Y2goKGVycikgPT4geyByZWplY3QoZXJyKTsgfSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRyZXNvbHZlKG1hc3RlckRiaCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogVGhlIGNvbm5lY3Rpb24gZmFjdG9yeSBmYXN0IGVudHJ5LCB3aXRob3V0IG5lZWQgdG8gY3JlYXRlIGFuIG9iamVjdFxuXHQgKiBAcmV0dXJucyB7Kn1cblx0ICovXG5cdHN0YXRpYyBtYXN0ZXJEYmhSTygpIHtcblx0XHRyZXR1cm4gdHJ4Q29udGV4dC5nZXQoXCJkYmhcIik7XG5cdH1cblxuXG5cdHN0YXRpYyBtYXN0ZXJEYmhEZXN0cm95KCkge1xuXHRcdGlmKG1hc3RlckRiaCkge1xuXHRcdFx0bWFzdGVyRGJoLmRlc3Ryb3koKTtcblx0XHRcdG1hc3RlckRiaCA9IG51bGw7XG5cdFx0fVxuXG5cdFx0dGhpcy5kZXN0cm95UG9sbCgpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldHVwIHRoZSBteXNxbCBjb25uZWN0aW9uIHBvb2wuIEFsbCBmdXJ0aGVyIGNvbm5lY3Rpb25zd2lsbCBiZVxuXHQgKiB0YWtlbiBmcm9tIHdpdGhpbiB0aGlzIHBvb2wuXG5cdCAqXG5cdCAqIGNvbmZpZzpcblx0ICogXHR1c2VyLCBwYXNzd29yZCwgaG9zdCAtIHJlZ3VsYXIgbXlzcWwgY29ubmVjdGlvbiBzZXR0aW5nc1xuXHQgKiBcdGNvbm5lY3Rpb25MaW1pdCAtIHRoZSBzaXplIG9mIHRoZSBjb25uZWN0aW9uIHBvb2wuIFBvb2wgaXMgdXNlZCBvbmx5IGlmIHBvb2xTaXplID4gMFxuXHQgKiBAcGFyYW0gY29uZmlnXG5cdCAqL1xuXHRzdGF0aWMgc2V0dXBQb29sKGNvbmZpZykge1xuXHRcdHRoaXMubWFzdGVyQ29uZmlnKGNvbmZpZyk7XG5cdFx0Y29ubmVjdGlvblBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNvbmZpZyk7XG5cdH1cblxuXHRzdGF0aWMgZGVzdHJveVBvbGwoKSB7XG5cdFx0aWYoY29ubmVjdGlvblBvb2wpIHtcblx0XHRcdGNvbm5lY3Rpb25Qb29sLmVuZCgoZXJyKSA9PiB7XG5cdFx0XHRcdC8vIGNvbnNvbGUubG9nKFwiY29ubmVjdGlvblBvb2wgZGVzdHJveWVkXCIpO1xuXHRcdFx0XHRjb25uZWN0aW9uUG9vbCA9IG51bGw7XG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cbn1cblxuXG5leHBvcnQgZGVmYXVsdCBNeXNxbERhdGFiYXNlMjtcblxuIl19
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

          if (this._config.names) {
            this.query(`SET NAMES "${this._config.names}"`);
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
    connectionPool.on('connection', connection => {
      if (config.names) {
        connection.query(`SET NAMES "${config.names}"`);
      }
    });
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9NeXNxbERhdGFiYXNlMi5qcyJdLCJuYW1lcyI6WyJtYXN0ZXJDb25maWciLCJtYXN0ZXJEYmgiLCJjb25uZWN0aW9uUG9vbCIsInRyeENvbnRleHQiLCJDb250ZXh0U3RvcmFnZSIsImNyZWF0ZU5hbWVzcGFjZSIsIk15c3FsRGF0YWJhc2UyIiwiY29uc3RydWN0b3IiLCJjb25maWciLCJfY29uZmlnIiwiX2RiIiwiX2NyZWF0ZWRGcm9tUG9vbCIsIm15c3FsIiwiY3JlYXRlQ29ubmVjdGlvbiIsIl90cmFuc2FjdGVkIiwiY29ubmVjdCIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwiZ2V0Q29ubmVjdGlvbiIsImVyciIsImRiaCIsImNpZCIsInBhcnNlSW50IiwiTWF0aCIsInJhbmRvbSIsImRlYnVnU1FMIiwiX3NlcSIsIm9uIiwic2VxdWVuY2UiLCJjb25zb2xlIiwibG9nIiwic3FsIiwibmFtZXMiLCJxdWVyeSIsImRpc2Nvbm5lY3QiLCJlbmQiLCJjbG9zZUFuZEV4aXQiLCJ0cnhEYiIsImRlc3Ryb3kiLCJzZXRUaW1lb3V0IiwicHJvY2VzcyIsImV4aXQiLCJ2YWx1ZXMiLCJjYiIsInF1ZXJ5QXN5bmMiLCJyZXMiLCJnZXRSb3ciLCJyb3dzIiwibGVuZ3RoIiwiZXhlY1RyYW5zYWN0aW9uIiwiZXhlY1RyYW5zYWN0aW9uQXN5bmMiLCJyZXVzZUNvbm5lY3Rpb24iLCJfZGVidWciLCJ0cnhQcm9taXNlIiwicnVuIiwic2V0IiwiZXgiLCJfcm9sbGJhY2siLCJfY29tbWl0IiwiY29tbWl0Iiwicm9sbGJhY2siLCJyZWxlYXNlIiwicmVtb3ZlSGFuZGxlcnMiLCJyZW1vdmVMaXN0ZW5lciIsIl9jbG9zZUFuZEV4aXQiLCJsb2dnZXIiLCJhcmd1bWVudHMiLCJvcHRpb25zIiwidHJ4RGJoIiwiZ2V0Iiwib3B0IiwiT2JqZWN0IiwiYXNzaWduIiwidGhlbiIsInIiLCJjYXRjaCIsIm1hc3RlckRiaFJPIiwibWFzdGVyRGJoRGVzdHJveSIsImRlc3Ryb3lQb2xsIiwic2V0dXBQb29sIiwiY3JlYXRlUG9vbCIsImNvbm5lY3Rpb24iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTs7QUFDQTs7QUFDQTs7OztBQUVBOzs7Ozs7Ozs7O0FBV0EsSUFBSUEsWUFBWSxHQUFHLEVBQW5CO0FBQ0EsSUFBSUMsU0FBUyxHQUFHLElBQWhCLEMsQ0FFQTtBQUNBOztBQUNBLElBQUlDLGNBQWMsR0FBRyxJQUFyQixDLENBRUE7QUFDQTtBQUNBO0FBQ0E7O0FBQ0EsSUFBSUMsVUFBVSxHQUFHQyxtQkFBZUMsZUFBZixDQUErQixXQUEvQixDQUFqQjtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFnQkEsTUFBTUMsY0FBTixDQUFxQjtBQUNwQjs7Ozs7OztBQU9BQyxFQUFBQSxXQUFXLENBQUNDLE1BQUQsRUFBUztBQUNuQixTQUFLQyxPQUFMLEdBQWUsb0JBQVksRUFBWixFQUFnQkQsTUFBaEIsQ0FBZjtBQUVBLFNBQUtFLEdBQUwsR0FBVyxJQUFYO0FBQ0EsU0FBS0MsZ0JBQUwsR0FBd0IsS0FBeEI7O0FBQ0EsUUFBRyxDQUFDVCxjQUFKLEVBQW9CO0FBQ25CLFdBQUtRLEdBQUwsR0FBV0UsZUFBTUMsZ0JBQU4sQ0FBdUIsS0FBS0osT0FBNUIsQ0FBWDtBQUNBOztBQUVELFNBQUtLLFdBQUwsR0FBbUIsQ0FBbkI7QUFDQTs7QUFFREMsRUFBQUEsT0FBTyxHQUFHO0FBQ1QsV0FBTyxJQUFJQyxPQUFKLENBQVksQ0FBQ0MsT0FBRCxFQUFVQyxNQUFWLEtBQXFCO0FBQ3ZDLFVBQUdoQixjQUFILEVBQW1CO0FBQ2xCQSxRQUFBQSxjQUFjLENBQUNpQixhQUFmLENBQTZCLENBQUNDLEdBQUQsRUFBTUMsR0FBTixLQUFjO0FBQzFDO0FBQ0EsZUFBS1YsZ0JBQUwsR0FBd0IsSUFBeEI7QUFDQSxlQUFLRCxHQUFMLEdBQVdXLEdBQVg7QUFDQSxlQUFLQyxHQUFMLEdBQVdDLFFBQVEsQ0FBQ0MsSUFBSSxDQUFDQyxNQUFMLEtBQWdCLE9BQWpCLENBQVIsR0FBb0MsR0FBL0MsQ0FKMEMsQ0FNMUM7O0FBQ0EsY0FBRyxLQUFLaEIsT0FBTCxDQUFhaUIsUUFBaEIsRUFBMEI7QUFDekIsZ0JBQUcsQ0FBQyxLQUFLaEIsR0FBTCxDQUFTaUIsSUFBYixFQUFtQjtBQUNsQixtQkFBS2pCLEdBQUwsQ0FBU2lCLElBQVQsR0FBZ0JKLFFBQVEsQ0FBQ0MsSUFBSSxDQUFDQyxNQUFMLEtBQWdCLE1BQWpCLENBQXhCO0FBQ0E7O0FBRUQsaUJBQUtmLEdBQUwsQ0FBU2tCLEVBQVQsQ0FBWSxTQUFaLEVBQXVCLFVBQVNDLFFBQVQsRUFBbUI7QUFDekNDLGNBQUFBLE9BQU8sQ0FBQ0MsR0FBUixDQUFZLFlBQVksS0FBS0osSUFBakIsR0FBd0IsS0FBcEMsRUFBMkNFLFFBQVEsQ0FBQ0csR0FBcEQ7QUFDQSxhQUZEO0FBR0E7O0FBRUQsY0FBR1osR0FBSCxFQUFRO0FBQ1BGLFlBQUFBLE1BQU0sQ0FBQ0UsR0FBRCxDQUFOO0FBQ0EsV0FGRCxNQUVPO0FBQ05ILFlBQUFBLE9BQU87QUFDUDtBQUNELFNBdEJEO0FBdUJBLE9BeEJELE1Bd0JPO0FBQ04sYUFBS0ssR0FBTCxHQUFXQyxRQUFRLENBQUNDLElBQUksQ0FBQ0MsTUFBTCxLQUFnQixPQUFqQixDQUFSLEdBQW9DLEdBQS9DOztBQUVBLGFBQUtmLEdBQUwsQ0FBU0ssT0FBVCxDQUFrQkssR0FBRCxJQUFTO0FBQ3pCLGNBQUdBLEdBQUgsRUFBUTtBQUFFRixZQUFBQSxNQUFNLENBQUNFLEdBQUQsQ0FBTjtBQUFjOztBQUV4QixjQUFHLEtBQUtYLE9BQUwsQ0FBYXdCLEtBQWhCLEVBQXVCO0FBQ3RCLGlCQUFLQyxLQUFMLENBQVksY0FBYSxLQUFLekIsT0FBTCxDQUFhd0IsS0FBTSxHQUE1QztBQUNBOztBQUVEaEIsVUFBQUEsT0FBTztBQUNQLFNBUkQ7QUFTQTtBQUNELEtBdENNLENBQVA7QUF1Q0E7O0FBR0RrQixFQUFBQSxVQUFVLEdBQUc7QUFLWixTQUFLekIsR0FBTCxDQUFTMEIsR0FBVDtBQUNBOztBQUVEQyxFQUFBQSxZQUFZLEdBQUc7QUFDZEMsSUFBQUEsS0FBSyxDQUFDQyxPQUFOO0FBQ0FDLElBQUFBLFVBQVUsQ0FBQyxNQUFNO0FBQUVDLE1BQUFBLE9BQU8sQ0FBQ0MsSUFBUjtBQUFpQixLQUExQixFQUE0QixHQUE1QixDQUFWO0FBQ0E7O0FBRURSLEVBQUFBLEtBQUssQ0FBQ0EsS0FBRCxFQUFRUyxNQUFSLEVBQWdCQyxFQUFoQixFQUFvQjtBQUN4QixXQUFPLEtBQUtsQyxHQUFMLENBQVN3QixLQUFULENBQWVBLEtBQWYsRUFBc0JTLE1BQXRCLEVBQThCQyxFQUE5QixDQUFQO0FBQ0E7O0FBRURDLEVBQUFBLFVBQVUsQ0FBQ1gsS0FBRCxFQUFRUyxNQUFSLEVBQWdCO0FBQ3pCLFdBQU8sSUFBSTNCLE9BQUosQ0FBWSxDQUFDQyxPQUFELEVBQVVDLE1BQVYsS0FBcUI7QUFDdkMsV0FBS2dCLEtBQUwsQ0FBV0EsS0FBWCxFQUFrQlMsTUFBbEIsRUFBMEIsQ0FBQ3ZCLEdBQUQsRUFBTTBCLEdBQU4sS0FBYztBQUN2QyxZQUFHMUIsR0FBSCxFQUFRO0FBQ1AsaUJBQU9GLE1BQU0sQ0FBQ0UsR0FBRCxDQUFiO0FBQ0EsU0FIc0MsQ0FJdkM7OztBQUNBSCxRQUFBQSxPQUFPLENBQUM2QixHQUFELENBQVA7QUFDQSxPQU5EO0FBT0EsS0FSTSxDQUFQO0FBU0E7QUFFRDs7Ozs7Ozs7O0FBT0EsUUFBTUMsTUFBTixDQUFhYixLQUFiLEVBQW9CUyxNQUFwQixFQUE0QjtBQUMzQixVQUFNSyxJQUFJLEdBQUcsTUFBTSxLQUFLSCxVQUFMLENBQWdCWCxLQUFoQixFQUF1QlMsTUFBdkIsQ0FBbkIsQ0FEMkIsQ0FFM0I7QUFDQTs7QUFDQSxRQUFHSyxJQUFJLENBQUNDLE1BQUwsS0FBZ0IsQ0FBbkIsRUFBc0I7QUFBRSxhQUFPLEVBQVA7QUFBWTs7QUFFcEMsV0FBT0QsSUFBSSxDQUFDLENBQUQsQ0FBWDtBQUNBO0FBRUQ7Ozs7Ozs7Ozs7O0FBU0EsUUFBTUUsZUFBTixDQUFzQk4sRUFBdEIsRUFBMEI7QUFDekIsV0FBTyxLQUFLTyxvQkFBTCxDQUEwQlAsRUFBMUIsQ0FBUDtBQUNBOztBQUVELFFBQU1PLG9CQUFOLENBQTJCUCxFQUEzQixFQUErQjtBQUM5QjtBQUNBLFFBQUlOLEtBQUssR0FBRyxJQUFaLENBRjhCLENBSTlCOztBQUNBLFFBQUcsS0FBS3hCLFdBQUwsR0FBbUIsQ0FBbkIsSUFBd0IsS0FBS0wsT0FBTCxDQUFhMkMsZUFBeEMsRUFBeUQ7QUFDeEQ7QUFDQWQsTUFBQUEsS0FBSyxHQUFHLElBQVI7O0FBQ0EsV0FBS2UsTUFBTCxDQUFZLFlBQVosRUFBMEJmLEtBQUssQ0FBQ2hCLEdBQWhDLEVBQXFDLEtBQUtSLFdBQTFDLEVBQXVELEtBQUtMLE9BQUwsQ0FBYTJDLGVBQXBFO0FBQ0EsS0FKRCxNQUlPO0FBS05kLE1BQUFBLEtBQUssR0FBRyxJQUFJLEtBQUsvQixXQUFULENBQXFCLEtBQUtFLE9BQTFCLENBQVI7QUFDQTZCLE1BQUFBLEtBQUssQ0FBQ3hCLFdBQU4sR0FBb0IsS0FBS0EsV0FBekI7QUFFQSxZQUFNd0IsS0FBSyxDQUFDdkIsT0FBTixFQUFOOztBQUNBLFdBQUtzQyxNQUFMLENBQVkseUJBQVosRUFBdUNmLEtBQUssQ0FBQ2hCLEdBQTdDO0FBQ0EsS0FuQjZCLENBcUI5Qjs7O0FBQ0EsUUFBR2dCLEtBQUssQ0FBQ3hCLFdBQU4sT0FBd0IsQ0FBM0IsRUFBOEI7QUFDN0IsWUFBTXdCLEtBQUssQ0FBQ08sVUFBTixDQUFpQixtQ0FBakIsQ0FBTjs7QUFDQSxXQUFLUSxNQUFMLENBQVksMEJBQVosRUFBd0NmLEtBQUssQ0FBQ2hCLEdBQTlDO0FBQ0E7O0FBQ0QsVUFBTWdDLFVBQVUsR0FBRyxJQUFJdEMsT0FBSixDQUFZLENBQUNDLE9BQUQsRUFBVUMsTUFBVixLQUFxQjtBQUNuRDtBQUNBZixNQUFBQSxVQUFVLENBQUNvRCxHQUFYLENBQWUsWUFBVztBQUN6QnBELFFBQUFBLFVBQVUsQ0FBQ3FELEdBQVgsQ0FBZSxLQUFmLEVBQXNCbEIsS0FBdEI7QUFFQSxZQUFJUSxHQUFHLEdBQUcsS0FBVjs7QUFDQSxZQUFJO0FBQ0hBLFVBQUFBLEdBQUcsR0FBRyxNQUFNRixFQUFFLENBQUNOLEtBQUQsQ0FBZDs7QUFDQSxlQUFLZSxNQUFMLENBQVksZUFBWixFQUE2QlAsR0FBN0I7QUFDQSxTQUhELENBR0UsT0FBTVcsRUFBTixFQUFVO0FBQ1gsZUFBS0osTUFBTCxDQUFZLGlDQUFaLEVBQStDSSxFQUEvQzs7QUFDQSxnQkFBTW5CLEtBQUssQ0FBQ29CLFNBQU4sRUFBTjtBQUNBeEMsVUFBQUEsTUFBTSxDQUFDdUMsRUFBRCxDQUFOO0FBQ0E7O0FBRUQsWUFBR1gsR0FBRyxLQUFLLEtBQVgsRUFBa0I7QUFDakIsZ0JBQU1SLEtBQUssQ0FBQ29CLFNBQU4sRUFBTjs7QUFDQSxlQUFLTCxNQUFMLENBQVksdUJBQVosRUFBcUMsS0FBSy9CLEdBQTFDO0FBQ0EsU0FIRCxNQUdPO0FBQ04sZ0JBQU1nQixLQUFLLENBQUNxQixPQUFOLEVBQU47O0FBQ0EsZUFBS04sTUFBTCxDQUFZLGdCQUFaO0FBQ0E7O0FBRURwQyxRQUFBQSxPQUFPO0FBQ1AsT0F0QkQ7QUF1QkEsS0F6QmtCLENBQW5CLENBMUI4QixDQXFEOUI7QUFDQTs7QUFDQSxVQUFNcUMsVUFBTixDQXZEOEIsQ0F5RDlCOztBQUNBLFFBQUdoQixLQUFLLElBQUksSUFBWixFQUFrQjtBQUNqQkEsTUFBQUEsS0FBSyxDQUFDQyxPQUFOO0FBQ0E7O0FBRUQsV0FBT0QsS0FBUDtBQUNBO0FBRUQ7Ozs7O0FBR0FzQixFQUFBQSxNQUFNLEdBQUc7QUFDUixXQUFPLEtBQUtELE9BQUwsRUFBUDtBQUNBOztBQUVELFFBQU1BLE9BQU4sR0FBZ0I7QUFDZixRQUFHLEtBQUs3QyxXQUFMLEdBQW1CLENBQXRCLEVBQXlCO0FBQ3hCLFdBQUtBLFdBQUw7O0FBRUEsVUFBRyxLQUFLQSxXQUFMLEtBQXFCLENBQXhCLEVBQTJCO0FBQzFCLGNBQU0sS0FBSytCLFVBQUwsQ0FBZ0IsdUJBQWhCLENBQU47QUFDQTtBQUNEO0FBQ0Q7QUFFRDs7Ozs7QUFHQWdCLEVBQUFBLFFBQVEsR0FBRztBQUNWLFdBQU8sS0FBS0gsU0FBTCxFQUFQO0FBQ0E7O0FBRUQsUUFBTUEsU0FBTixHQUFrQjtBQUNqQixRQUFHLEtBQUs1QyxXQUFMLEdBQW1CLENBQXRCLEVBQXlCO0FBQ3hCLFdBQUtBLFdBQUw7O0FBRUEsVUFBRyxLQUFLQSxXQUFMLEtBQXFCLENBQXhCLEVBQTJCO0FBQzFCLGNBQU0sS0FBSytCLFVBQUwsQ0FBZ0IsVUFBaEIsQ0FBTjtBQUNBO0FBQ0Q7QUFDRDs7QUFFRE4sRUFBQUEsT0FBTyxHQUFHO0FBQ1Q7QUFDQSxRQUFHLEtBQUs1QixnQkFBUixFQUEwQjtBQUN6QixVQUFHLEtBQUtELEdBQUwsSUFBWSxJQUFmLEVBQXFCO0FBQUUsYUFBS0EsR0FBTCxDQUFTb0QsT0FBVDtBQUFxQjtBQUM1QyxLQUZELE1BRU87QUFDTixXQUFLcEQsR0FBTCxDQUFTNkIsT0FBVDtBQUNBOztBQUVELFNBQUt3QixjQUFMO0FBQ0E7O0FBRURBLEVBQUFBLGNBQWMsR0FBRztBQUNoQnRCLElBQUFBLE9BQU8sQ0FBQ3VCLGNBQVIsQ0FBdUIsU0FBdkIsRUFBa0MsS0FBS0MsYUFBdkM7QUFDQXhCLElBQUFBLE9BQU8sQ0FBQ3VCLGNBQVIsQ0FBdUIsUUFBdkIsRUFBaUMsS0FBS0MsYUFBdEM7QUFDQTs7QUFFREEsRUFBQUEsYUFBYSxHQUFHO0FBQ2Z6QixJQUFBQSxVQUFVLENBQUMsTUFBTTtBQUFFQyxNQUFBQSxPQUFPLENBQUNDLElBQVI7QUFBaUIsS0FBMUIsRUFBNEIsR0FBNUIsQ0FBVjtBQUNBOztBQUVEVyxFQUFBQSxNQUFNLEdBQUc7QUFDUixRQUFHLEtBQUs1QyxPQUFMLENBQWF5RCxNQUFoQixFQUF3QjtBQUN2QixXQUFLekQsT0FBTCxDQUFheUQsTUFBYixDQUFvQm5DLEdBQXBCLENBQXdCLEdBQUdvQyxTQUEzQjtBQUNBO0FBQ0Q7QUFFRDs7Ozs7O0FBSUEsU0FBT25FLFlBQVAsQ0FBb0JRLE1BQXBCLEVBQTRCO0FBQzNCUixJQUFBQSxZQUFZLEdBQUdRLE1BQWY7QUFDQTtBQUVEOzs7Ozs7OztBQU1BLFNBQU9QLFNBQVAsQ0FBaUJtRSxPQUFPLEdBQUcsRUFBM0IsRUFBK0I7QUFDOUIsV0FBTyxJQUFJcEQsT0FBSixDQUFZLENBQUNDLE9BQUQsRUFBVUMsTUFBVixLQUFxQjtBQUN2QztBQUNBLFlBQU1tRCxNQUFNLEdBQUdsRSxVQUFVLENBQUNtRSxHQUFYLENBQWUsS0FBZixDQUFmOztBQUNBLFVBQUdELE1BQUgsRUFBVztBQUNWcEQsUUFBQUEsT0FBTyxDQUFDb0QsTUFBRCxDQUFQO0FBQ0EsT0FMc0MsQ0FPdkM7OztBQUNBLFVBQUcsQ0FBQ3BFLFNBQUosRUFBZTtBQUNkLGNBQU1zRSxHQUFHLEdBQUdDLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjLEVBQWQsRUFBa0J6RSxZQUFsQixFQUFnQ29FLE9BQWhDLENBQVo7QUFDQW5FLFFBQUFBLFNBQVMsR0FBRyxJQUFJLElBQUosQ0FBU3NFLEdBQVQsQ0FBWjtBQUVBdEUsUUFBQUEsU0FBUyxDQUNQYyxPQURGLEdBRUUyRCxJQUZGLENBRVFDLENBQUQsSUFBTztBQUFFMUQsVUFBQUEsT0FBTyxDQUFDaEIsU0FBRCxDQUFQO0FBQXFCLFNBRnJDLEVBR0UyRSxLQUhGLENBR1N4RCxHQUFELElBQVM7QUFBRUYsVUFBQUEsTUFBTSxDQUFDRSxHQUFELENBQU47QUFBYyxTQUhqQztBQUlBLE9BUkQsTUFRTztBQUNOSCxRQUFBQSxPQUFPLENBQUNoQixTQUFELENBQVA7QUFDQTtBQUNELEtBbkJNLENBQVA7QUFvQkE7QUFFRDs7Ozs7O0FBSUEsU0FBTzRFLFdBQVAsR0FBcUI7QUFDcEIsV0FBTzFFLFVBQVUsQ0FBQ21FLEdBQVgsQ0FBZSxLQUFmLENBQVA7QUFDQTs7QUFHRCxTQUFPUSxnQkFBUCxHQUEwQjtBQUN6QixRQUFHN0UsU0FBSCxFQUFjO0FBQ2JBLE1BQUFBLFNBQVMsQ0FBQ3NDLE9BQVY7QUFDQXRDLE1BQUFBLFNBQVMsR0FBRyxJQUFaO0FBQ0E7O0FBRUQsU0FBSzhFLFdBQUw7QUFDQTtBQUVEOzs7Ozs7Ozs7OztBQVNBLFNBQU9DLFNBQVAsQ0FBaUJ4RSxNQUFqQixFQUF5QjtBQUN4QixTQUFLUixZQUFMLENBQWtCUSxNQUFsQjtBQUNBTixJQUFBQSxjQUFjLEdBQUdVLGVBQU1xRSxVQUFOLENBQWlCekUsTUFBakIsQ0FBakI7QUFFQU4sSUFBQUEsY0FBYyxDQUFDMEIsRUFBZixDQUFrQixZQUFsQixFQUFrQ3NELFVBQUQsSUFBZ0I7QUFDaEQsVUFBRzFFLE1BQU0sQ0FBQ3lCLEtBQVYsRUFBaUI7QUFDaEJpRCxRQUFBQSxVQUFVLENBQUNoRCxLQUFYLENBQWtCLGNBQWExQixNQUFNLENBQUN5QixLQUFNLEdBQTVDO0FBQ0E7QUFDRCxLQUpEO0FBS0E7O0FBRUQsU0FBTzhDLFdBQVAsR0FBcUI7QUFDcEIsUUFBRzdFLGNBQUgsRUFBbUI7QUFDbEJBLE1BQUFBLGNBQWMsQ0FBQ2tDLEdBQWYsQ0FBb0JoQixHQUFELElBQVM7QUFDM0I7QUFDQWxCLFFBQUFBLGNBQWMsR0FBRyxJQUFqQjtBQUNBLE9BSEQ7QUFJQTtBQUNEOztBQXhVbUI7O2VBNFVOSSxjIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGxvZGFzaE1lcmdlIGZyb20gJ2xvZGFzaC9tZXJnZSc7XG5pbXBvcnQgbXlzcWwgZnJvbSAnbXlzcWwnO1xuaW1wb3J0IENvbnRleHRTdG9yYWdlIGZyb20gJ2Nscy1ob29rZWQnO1xuXG4vKipcbiAqIFRoZSBNeVNRTCBjb25uZWN0aW9uIHdyYXBwZXIgd2hpY2ggcHJvdmlkZXMgdGhlIGZvbGxvd2luZyBmZWF0dXJlczpcbiAqIC0gXCJtYXN0ZXJcIiBkYiBjb25uZWN0aW9uIGZhY3RvcnkgZnVuY3Rpb25cbiAqIC0gc3luYyBxdWVyaWVzICh1c2luZyBGdXR1cmUpXG4gKiAtIGFzeW5jIHF1ZXJpZXMgKHVzaW5nIFByb21pc2VzIC0gbm90IHRlc3RlZCB5ZXQpXG4gKiAtIG5lc3RlZCB0cmFuc2FjdGlvbnMgc3VwcG9ydCAoaW4gcHJvZ3Jlc3MpXG4gKiAtIGNvbm5lY3Rpb24gcG9vbGluZyBmb3IgdHJhbnNhY3Rpb25cbiAqIC0gbG9jYWwgY29udGV4dCBvZiBcIm1hc3RlclwiIGRiIGNvbm5lY3Rpb24gaW5zaWRlIHRoZSB0cmFuc2FjdGlvblxuICpcbiAqL1xuXG5sZXQgbWFzdGVyQ29uZmlnID0ge307XG5sZXQgbWFzdGVyRGJoID0gbnVsbDtcblxuLy8gQ29ubmVjdGlvbiBwb29sXG4vLyBJZiBjb25uZWN0aW9uIHBvb2wgaGFzIGJlZW4gc2V0IHVwLCBNeXNxbERhdGFiYXNlIHdpbGwgcGljayBjb25uZWN0aW9ucyBmcm9tIGl0XG5sZXQgY29ubmVjdGlvblBvb2wgPSBudWxsO1xuXG4vLyBMb2NhbCBkYmggY29udGV4dCBmb3IgdHJhbnNhY3Rpb24uIEVhY2ggdHJhbnNhY3Rpb24gZ2VuZXJhdGVzIGl0cyBvd24gbG9jYWxcbi8vIGNvbnRleHQgd2l0aCBpdHMgb3duIFwiY3VycmVudCBnbG9iYWxcIiBkYmguXG4vLyBEdXJpbmcgdGhlIHRyYW5zYWN0aW9ucyBzdGFydCwgdGhlIHZhbHVlIGlzIHBvcHVsYXRlZCB3aXRoIGEgdHJhbnNhY3Rpb25cbi8vIGRiaCwgc28gYWxsIHVwY29taW5nIG1hc3RlckRiaCgpIGNhbGxzIHJldHVybiB0aGUgZGJoIGFjdHVhbCBmb3IgdGhpcyB0cmFuc2FjdGlvbi5cbmxldCB0cnhDb250ZXh0ID0gQ29udGV4dFN0b3JhZ2UuY3JlYXRlTmFtZXNwYWNlKCdteXNxbC1kYmgnKTtcblxuLyoqXG4gKiBUaGUgZGF0YWJhc2UgcHJvY2Vzc2luZyBjbGFzcy5cbiAqXG4gKiBUcmFuc2FjdGlvbiBwcm9jZXNzaW5nXG4gKlxuICogVGhlIHByb2JsZW0gaXMgdGhhdCBhbGwgcXVlcmllcyBzaGFyZSB0aGUgc2FtZSBteXNxbCBjb25uZWN0aW9uLiBUaHVzLCBldmVuXG4gKiBpZiB3ZSBoYXZlIHN0YXJ0ZWQgdGhlIHRyYW5zYWN0aW9uLCBvdGhlciBxdWVyaWVzIGNhbiBpbnRlcnZlbmUgd2l0aGluIGl0LlxuICpcbiAqIFRvIGF2b2lkIHRoaXMsIHdlIGNyZWF0ZSBhIHNlcGFyYXRlIGNvbm5lY3Rpb24gd2hlbiBjYWxsaW5nIGNvZGUgc3RhcnRzXG4gKiB0cmFuc2FjdGlvbi4gVGhlbiB3ZSByZXR1cm4gdGhlIG5ldyBkYXRhYmFzZSBoYW5kbGUgKFwidHJhbnNhY3RlZFwiKSB0byB1c2UsXG4gKiBhbmQgY29tbWl0L3JvbGxiYWNrIGF0IHRoZSBlbmQuXG4gKlxuICogdmFyIGRiaCA9IGRiaC5iZWdpblRyYW5zYWN0aW9uKCk7IC8vIG5ldyBkYmggaXMgY3JlYXRlZCBoZXJlXG4gKiAuLi4uXG4gKiBkYmguY29tbWl0KCk7XG4gKi9cbmNsYXNzIE15c3FsRGF0YWJhc2UyIHtcblx0LyoqXG5cdCAqIGNvbmZpZzpcblx0ICogXHR1c2VyLCBwYXNzd29yZCwgaG9zdCAtIHJlZ3VsYXIgbXlzcWwgY29ubmVjdGlvbiBzZXR0aW5nc1xuXHQgKiBcdHJldXNlQ29ubmVjdGlvbiAtIGR1cmluZyBhIHRyYW5zYWN0aW9uIHN0YXJ0LCBkb24ndCBnZXQgYSBuZXcgY29ubmVjdGlvblxuXHQgKiBcdGRlYnVnU1FMIC0gbG9nIGFsbCBTUUwgcXVlcmllcyAoZGVidWcpXG5cdCAqIEBwYXJhbSBjb25maWdcblx0ICovXG5cdGNvbnN0cnVjdG9yKGNvbmZpZykge1xuXHRcdHRoaXMuX2NvbmZpZyA9IGxvZGFzaE1lcmdlKHt9LCBjb25maWcpO1xuXG5cdFx0dGhpcy5fZGIgPSBudWxsO1xuXHRcdHRoaXMuX2NyZWF0ZWRGcm9tUG9vbCA9IGZhbHNlO1xuXHRcdGlmKCFjb25uZWN0aW9uUG9vbCkge1xuXHRcdFx0dGhpcy5fZGIgPSBteXNxbC5jcmVhdGVDb25uZWN0aW9uKHRoaXMuX2NvbmZpZyk7XG5cdFx0fVxuXG5cdFx0dGhpcy5fdHJhbnNhY3RlZCA9IDA7XG5cdH1cblxuXHRjb25uZWN0KCkge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRpZihjb25uZWN0aW9uUG9vbCkge1xuXHRcdFx0XHRjb25uZWN0aW9uUG9vbC5nZXRDb25uZWN0aW9uKChlcnIsIGRiaCkgPT4ge1xuXHRcdFx0XHRcdC8vIGNvbnNvbGUubG9nKFwiY29ubmVjdGlvbiB0YWtlbiBmcm9tIHBvb2xcIik7XG5cdFx0XHRcdFx0dGhpcy5fY3JlYXRlZEZyb21Qb29sID0gdHJ1ZTtcblx0XHRcdFx0XHR0aGlzLl9kYiA9IGRiaDtcblx0XHRcdFx0XHR0aGlzLmNpZCA9IHBhcnNlSW50KE1hdGgucmFuZG9tKCkgKiAxMDAwMDAwKSArIFwicFwiO1xuXG5cdFx0XHRcdFx0Ly8gU1FMIGxvZ2dpbmdcblx0XHRcdFx0XHRpZih0aGlzLl9jb25maWcuZGVidWdTUUwpIHtcblx0XHRcdFx0XHRcdGlmKCF0aGlzLl9kYi5fc2VxKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuX2RiLl9zZXEgPSBwYXJzZUludChNYXRoLnJhbmRvbSgpICogMTAwMDAwKTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0dGhpcy5fZGIub24oJ2VucXVldWUnLCBmdW5jdGlvbihzZXF1ZW5jZSkge1xuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhcIlFVRVJZIChcIiArIHRoaXMuX3NlcSArIFwiKTogXCIsIHNlcXVlbmNlLnNxbCk7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZihlcnIpIHtcblx0XHRcdFx0XHRcdHJlamVjdChlcnIpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMuY2lkID0gcGFyc2VJbnQoTWF0aC5yYW5kb20oKSAqIDEwMDAwMDApICsgXCJzXCI7XG5cblx0XHRcdFx0dGhpcy5fZGIuY29ubmVjdCgoZXJyKSA9PiB7XG5cdFx0XHRcdFx0aWYoZXJyKSB7IHJlamVjdChlcnIpOyB9XG5cblx0XHRcdFx0XHRpZih0aGlzLl9jb25maWcubmFtZXMpIHtcblx0XHRcdFx0XHRcdHRoaXMucXVlcnkoYFNFVCBOQU1FUyBcIiR7dGhpcy5fY29uZmlnLm5hbWVzfVwiYCk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9KTtcblx0fVxuXG5cblx0ZGlzY29ubmVjdCgpIHtcblx0XHRpZihUQVJHRVQgPT0gXCJkZXZlbG9wbWVudFwiKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgJHt0aGlzLl9kYi50aHJlYWRJZH06IGNsb3NpbmcgbXlzcWwgdGhyZWFkSWRgKTtcblx0XHR9XG5cblx0XHR0aGlzLl9kYi5lbmQoKTtcblx0fVxuXG5cdGNsb3NlQW5kRXhpdCgpIHtcblx0XHR0cnhEYi5kZXN0cm95KCk7XG5cdFx0c2V0VGltZW91dCgoKSA9PiB7IHByb2Nlc3MuZXhpdCgpOyB9LCA1MDApO1xuXHR9XG5cblx0cXVlcnkocXVlcnksIHZhbHVlcywgY2IpIHtcblx0XHRyZXR1cm4gdGhpcy5fZGIucXVlcnkocXVlcnksIHZhbHVlcywgY2IpO1xuXHR9XG5cblx0cXVlcnlBc3luYyhxdWVyeSwgdmFsdWVzKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdHRoaXMucXVlcnkocXVlcnksIHZhbHVlcywgKGVyciwgcmVzKSA9PiB7XG5cdFx0XHRcdGlmKGVycikge1xuXHRcdFx0XHRcdHJldHVybiByZWplY3QoZXJyKTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBjb25zb2xlLmxvZyhcImJlZm9yZSByZXNvbHZlIG9mXCIsIHF1ZXJ5LCByZXMpO1xuXHRcdFx0XHRyZXNvbHZlKHJlcyk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBIHNob3J0Y3V0IGZ1bmN0aW9uIHRvIGdldCBhIHNpbmdsZSByb3dzIHdpdGhvdXQgbWVzc2luZyB3aXRoIHJvdyBhcnJheXNcblx0ICpcblx0ICogQHBhcmFtIHF1ZXJ5XG5cdCAqIEBwYXJhbSB2YWx1ZXNcblx0ICogQHJldHVybnMge09iamVjdH0gLSB0aGUgb2JqZWN0IHdpdGggc2VsZWN0ZWQgZmllbGRzIG9yIHt9IG9mIG5vIHJvd3MgZm91bmRcblx0ICovXG5cdGFzeW5jIGdldFJvdyhxdWVyeSwgdmFsdWVzKSB7XG5cdFx0Y29uc3Qgcm93cyA9IGF3YWl0IHRoaXMucXVlcnlBc3luYyhxdWVyeSwgdmFsdWVzKTtcblx0XHQvLyBJdCBpcyBxdWVzdGlvbmFibGU6IHNob3VsZCB3ZSByZXR1cm4ge30gb3IgbnVsbCBiZWxvdz8gV2hpY2ggaXMgZWFzaWVyIHRvIHVzZT9cblx0XHQvLyB7fSBzZWVtcyB0byBiZSBzYWZlciB0byB1c2UsIG5vIG51bGwuZmllbGQgZXJyb3Igd2lsbCBmaXJlXG5cdFx0aWYocm93cy5sZW5ndGggPT09IDApIHsgcmV0dXJuIHt9OyB9XG5cblx0XHRyZXR1cm4gcm93c1swXTtcblx0fVxuXG5cdC8qKlxuXHQgKiBCZWdpbnMgdGhlIGRhdGFiYXNlIHRyYW5zYWN0aW9uLlxuXHQgKlxuXHQgKiBVc2VkIF9jb25maWc6XG5cdCAqIFx0cmV1c2VDb25uZWN0aW9uIC0gdXNlIHRoZSBzYW1lIGNvbm5lY3Rpb24gKGRlYnVnKVxuXHQgKlxuXHQgKiBAcGFyYW0ge0Z1bmN0aW9ufSBjYiAtIHRoZSBjYWxsYmFjayB0byBjYWxsLiBTaG91bGQgcmV0dXJuICdmYWxzZScgaWZcblx0ICogXHR0cmFuc2FjdGlvbiBzaG91bGQgYmUgcm9sbGVkIGJhY2tcblx0ICovXG5cdGFzeW5jIGV4ZWNUcmFuc2FjdGlvbihjYikge1xuXHRcdHJldHVybiB0aGlzLmV4ZWNUcmFuc2FjdGlvbkFzeW5jKGNiKTtcblx0fVxuXG5cdGFzeW5jIGV4ZWNUcmFuc2FjdGlvbkFzeW5jKGNiKSB7XG5cdFx0Ly8gVE9ETyBHRzogcG9ydCB0aGUgbmVzdGVkIHRyYXNhY3Rpb25zIGNvZGUgaGVyZVxuXHRcdGxldCB0cnhEYiA9IG51bGw7XG5cblx0XHQvLyBTZXQgX2NvbmZpZy5yZXVzZUNvbm5lY3Rpb249dHJ1ZSB0byBkZWJ1ZyB0cmFuc2FjdGlvbiBydW4gb24gdGhlIHNhbWUgY29ubmVjdGlvblxuXHRcdGlmKHRoaXMuX3RyYW5zYWN0ZWQgPiAwIHx8IHRoaXMuX2NvbmZpZy5yZXVzZUNvbm5lY3Rpb24pIHtcblx0XHRcdC8vIEluIGEgbmVzdGVkIHRyYW5zYWN0aW9uLCBkb24ndCBjcmVhdGUgYSBuZXcgY29ubmVjdGlvblxuXHRcdFx0dHJ4RGIgPSB0aGlzO1xuXHRcdFx0dGhpcy5fZGVidWcoXCJyZXVzZWQgZGJoXCIsIHRyeERiLmNpZCwgdGhpcy5fdHJhbnNhY3RlZCwgdGhpcy5fY29uZmlnLnJldXNlQ29ubmVjdGlvbik7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGlmKFRBUkdFVCA9PT0gXCJkZXZlbG9wbWVudFwiKSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBPbGQgJHt0aGlzLl9kYi50aHJlYWRJZH0gaXMgY3JlYXRpbmcgdHJhbnNhY3Rpb24gY29ubmVjdGlvbmApO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnhEYiA9IG5ldyB0aGlzLmNvbnN0cnVjdG9yKHRoaXMuX2NvbmZpZyk7XG5cdFx0XHR0cnhEYi5fdHJhbnNhY3RlZCA9IHRoaXMuX3RyYW5zYWN0ZWQ7XG5cblx0XHRcdGF3YWl0IHRyeERiLmNvbm5lY3QoKTtcblx0XHRcdHRoaXMuX2RlYnVnKFwiY3JlYXRlZCB0cmFuc2FjdGlvbiBkYmhcIiwgdHJ4RGIuY2lkKTtcblx0XHR9XG5cblx0XHQvLyBPbmx5IGV4ZWN1dGUgU1RBUlQgVFJBTlNBQ1RJT04gZm9yIHRoZSBmaXJzdC1sZXZlbCB0cnhcblx0XHRpZih0cnhEYi5fdHJhbnNhY3RlZCsrID09PSAwKSB7XG5cdFx0XHRhd2FpdCB0cnhEYi5xdWVyeUFzeW5jKFwiU1RBUlQgVFJBTlNBQ1RJT04gIC8qIGZyb20gdHJ4ICovXCIpO1xuXHRcdFx0dGhpcy5fZGVidWcoXCJTVEFSVCBUUkFOU0FDVElPTiBpbiBkYmhcIiwgdHJ4RGIuY2lkKTtcblx0XHR9XG5cdFx0Y29uc3QgdHJ4UHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdC8vIEV4ZWN1dGUgdHJhbnNhY3Rpb24gYW5kIGNyZWF0ZSBhIHJ1bm5pbmcgY29udGV4dCBmb3IgaXRcblx0XHRcdHRyeENvbnRleHQucnVuKGFzeW5jKCkgPT4ge1xuXHRcdFx0XHR0cnhDb250ZXh0LnNldChcImRiaFwiLCB0cnhEYik7XG5cblx0XHRcdFx0bGV0IHJlcyA9IGZhbHNlO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdHJlcyA9IGF3YWl0IGNiKHRyeERiKTtcblx0XHRcdFx0XHR0aGlzLl9kZWJ1ZyhcImdvdCBjYiByZXBseTpcIiwgcmVzKTtcblx0XHRcdFx0fSBjYXRjaChleCkge1xuXHRcdFx0XHRcdHRoaXMuX2RlYnVnKFwiSW50ZXJuYWwgdHJhbnNhY3Rpb24gZXhjZXB0aW9uOlwiLCBleCk7XG5cdFx0XHRcdFx0YXdhaXQgdHJ4RGIuX3JvbGxiYWNrKCk7XG5cdFx0XHRcdFx0cmVqZWN0KGV4KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmKHJlcyA9PT0gZmFsc2UpIHtcblx0XHRcdFx0XHRhd2FpdCB0cnhEYi5fcm9sbGJhY2soKTtcblx0XHRcdFx0XHR0aGlzLl9kZWJ1ZyhcImRpZCB0aGUgcm9sbGJhY2ssIGRiaFwiLCB0aGlzLmNpZCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0YXdhaXQgdHJ4RGIuX2NvbW1pdCgpO1xuXHRcdFx0XHRcdHRoaXMuX2RlYnVnKFwiZGlkIHRoZSBjb21taXRcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIFdhaXQgZm9yIHRyYW5zYWN0aW9uIHVzZXIgZnVuY3Rpb24gdG8gZmluaXNoXG5cdFx0Ly8gKHRyeENvbnRleHQucnVuIGRvZXMgbm90IHN1cHBvcnQgYXN5bmNzIHRodXMgZXhpc3RzIGltbWVkaWF0ZWx5KVxuXHRcdGF3YWl0IHRyeFByb21pc2U7XG5cblx0XHQvLyBJZiB3ZSBjcmVhdGVkIGEgbmV3IGNvbm5lY3Rpb24sIGRlc3Ryb3kgaXRcblx0XHRpZih0cnhEYiAhPSB0aGlzKSB7XG5cdFx0XHR0cnhEYi5kZXN0cm95KCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHRyeERiO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbW1pdHMgdGhlIGN1cnJlbnQgZGF0YWJhc2UgdHJhbnNhY3Rpb25cblx0ICovXG5cdGNvbW1pdCgpIHtcblx0XHRyZXR1cm4gdGhpcy5fY29tbWl0KCk7XG5cdH1cblxuXHRhc3luYyBfY29tbWl0KCkge1xuXHRcdGlmKHRoaXMuX3RyYW5zYWN0ZWQgPiAwKSB7XG5cdFx0XHR0aGlzLl90cmFuc2FjdGVkLS07XG5cblx0XHRcdGlmKHRoaXMuX3RyYW5zYWN0ZWQgPT09IDApIHtcblx0XHRcdFx0YXdhaXQgdGhpcy5xdWVyeUFzeW5jKFwiQ09NTUlUIC8qIGZyb20gdHJ4ICovXCIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBSb2xscyBiYWNrIHRoZSBjdXJyZW50IGRhdGFiYXNlIHRyYW5zYWN0aW9uXG5cdCAqL1xuXHRyb2xsYmFjaygpIHtcblx0XHRyZXR1cm4gdGhpcy5fcm9sbGJhY2soKTtcblx0fVxuXG5cdGFzeW5jIF9yb2xsYmFjaygpIHtcblx0XHRpZih0aGlzLl90cmFuc2FjdGVkID4gMCkge1xuXHRcdFx0dGhpcy5fdHJhbnNhY3RlZC0tO1xuXG5cdFx0XHRpZih0aGlzLl90cmFuc2FjdGVkID09PSAwKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMucXVlcnlBc3luYyhcIlJPTExCQUNLXCIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdGRlc3Ryb3koKSB7XG5cdFx0Ly8gQ29ubmVjdGlvbnMgY3JlYXRlZCBmcm9tIHBvb2wgYXJlIHRvIGJlIHJlbGVhc2VkLCBkaXJlY3QgY29ubmVjdGlvbnMgZGVzdHJveWVkXG5cdFx0aWYodGhpcy5fY3JlYXRlZEZyb21Qb29sKSB7XG5cdFx0XHRpZih0aGlzLl9kYiAhPSBudWxsKSB7IHRoaXMuX2RiLnJlbGVhc2UoKTsgfVxuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLl9kYi5kZXN0cm95KCk7XG5cdFx0fVxuXG5cdFx0dGhpcy5yZW1vdmVIYW5kbGVycygpO1xuXHR9XG5cblx0cmVtb3ZlSGFuZGxlcnMoKSB7XG5cdFx0cHJvY2Vzcy5yZW1vdmVMaXN0ZW5lcignU0lHVEVSTScsIHRoaXMuX2Nsb3NlQW5kRXhpdCk7XG5cdFx0cHJvY2Vzcy5yZW1vdmVMaXN0ZW5lcignU0lHSU5UJywgdGhpcy5fY2xvc2VBbmRFeGl0KTtcblx0fVxuXG5cdF9jbG9zZUFuZEV4aXQoKSB7XG5cdFx0c2V0VGltZW91dCgoKSA9PiB7IHByb2Nlc3MuZXhpdCgpOyB9LCA1MDApO1xuXHR9XG5cblx0X2RlYnVnKCkge1xuXHRcdGlmKHRoaXMuX2NvbmZpZy5sb2dnZXIpIHtcblx0XHRcdHRoaXMuX2NvbmZpZy5sb2dnZXIubG9nKC4uLmFyZ3VtZW50cyk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFRoZSBjb25uZWN0aW9uIGNvbmZpZ3VyYXRpb24gZm9yIG1hc3RlckRiaFxuXHQgKiBAcGFyYW0gY29uZmlnXG5cdCAqL1xuXHRzdGF0aWMgbWFzdGVyQ29uZmlnKGNvbmZpZykge1xuXHRcdG1hc3RlckNvbmZpZyA9IGNvbmZpZztcblx0fVxuXG5cdC8qKlxuXHQgKiBUaGUgY29ubmVjdGlvbiBmYWN0b3J5LiBDcmVhdGVzIGEgZ2xvYmFsIGNvbm5lY3Rpb24gdG8gYmUgdXNlZCBieSBkZWZhdWx0LlxuXHQgKlxuXHQgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucyAtIGFkZGl0aW9uYWwgb3B0aW9ucyB0byBwYXNzIHRvIG1hc3RlciBkYmggY3JlYXRpb25cblx0ICogQHJldHVybnMge015c3FsRGF0YWJhc2UyfSBjdXJyZW50IG15c3FsIGRhdGFiYXNlIGNvbm5lY3Rpb24gY2xhc3Ncblx0ICovXG5cdHN0YXRpYyBtYXN0ZXJEYmgob3B0aW9ucyA9IHt9KSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdC8vIEZpcnN0IHRyeSB0byBnZXQgdGhlIGxvY2FsIHNjb3BlIGRiaCBvZiB0aGUgY3VycmVudCB0cmFuc2FjdGlvblxuXHRcdFx0Y29uc3QgdHJ4RGJoID0gdHJ4Q29udGV4dC5nZXQoXCJkYmhcIik7XG5cdFx0XHRpZih0cnhEYmgpIHtcblx0XHRcdFx0cmVzb2x2ZSh0cnhEYmgpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBJZiBubyBnbG9iYWwgZGJoIGV4aXN0LCBjcmVhdGUgaXRcblx0XHRcdGlmKCFtYXN0ZXJEYmgpIHtcblx0XHRcdFx0Y29uc3Qgb3B0ID0gT2JqZWN0LmFzc2lnbih7fSwgbWFzdGVyQ29uZmlnLCBvcHRpb25zKTtcblx0XHRcdFx0bWFzdGVyRGJoID0gbmV3IHRoaXMob3B0KTtcblxuXHRcdFx0XHRtYXN0ZXJEYmhcblx0XHRcdFx0XHQuY29ubmVjdCgpXG5cdFx0XHRcdFx0LnRoZW4oKHIpID0+IHsgcmVzb2x2ZShtYXN0ZXJEYmgpOyB9KVxuXHRcdFx0XHRcdC5jYXRjaCgoZXJyKSA9PiB7IHJlamVjdChlcnIpOyB9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHJlc29sdmUobWFzdGVyRGJoKTtcblx0XHRcdH1cblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBUaGUgY29ubmVjdGlvbiBmYWN0b3J5IGZhc3QgZW50cnksIHdpdGhvdXQgbmVlZCB0byBjcmVhdGUgYW4gb2JqZWN0XG5cdCAqIEByZXR1cm5zIHsqfVxuXHQgKi9cblx0c3RhdGljIG1hc3RlckRiaFJPKCkge1xuXHRcdHJldHVybiB0cnhDb250ZXh0LmdldChcImRiaFwiKTtcblx0fVxuXG5cblx0c3RhdGljIG1hc3RlckRiaERlc3Ryb3koKSB7XG5cdFx0aWYobWFzdGVyRGJoKSB7XG5cdFx0XHRtYXN0ZXJEYmguZGVzdHJveSgpO1xuXHRcdFx0bWFzdGVyRGJoID0gbnVsbDtcblx0XHR9XG5cblx0XHR0aGlzLmRlc3Ryb3lQb2xsKCk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0dXAgdGhlIG15c3FsIGNvbm5lY3Rpb24gcG9vbC4gQWxsIGZ1cnRoZXIgY29ubmVjdGlvbnN3aWxsIGJlXG5cdCAqIHRha2VuIGZyb20gd2l0aGluIHRoaXMgcG9vbC5cblx0ICpcblx0ICogY29uZmlnOlxuXHQgKiBcdHVzZXIsIHBhc3N3b3JkLCBob3N0IC0gcmVndWxhciBteXNxbCBjb25uZWN0aW9uIHNldHRpbmdzXG5cdCAqIFx0Y29ubmVjdGlvbkxpbWl0IC0gdGhlIHNpemUgb2YgdGhlIGNvbm5lY3Rpb24gcG9vbC4gUG9vbCBpcyB1c2VkIG9ubHkgaWYgcG9vbFNpemUgPiAwXG5cdCAqIEBwYXJhbSBjb25maWdcblx0ICovXG5cdHN0YXRpYyBzZXR1cFBvb2woY29uZmlnKSB7XG5cdFx0dGhpcy5tYXN0ZXJDb25maWcoY29uZmlnKTtcblx0XHRjb25uZWN0aW9uUG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY29uZmlnKTtcblxuXHRcdGNvbm5lY3Rpb25Qb29sLm9uKCdjb25uZWN0aW9uJywgIChjb25uZWN0aW9uKSA9PiB7XG5cdFx0XHRpZihjb25maWcubmFtZXMpIHtcblx0XHRcdFx0Y29ubmVjdGlvbi5xdWVyeShgU0VUIE5BTUVTIFwiJHtjb25maWcubmFtZXN9XCJgKTtcblx0XHRcdH1cblx0XHR9KTtcblx0fVxuXG5cdHN0YXRpYyBkZXN0cm95UG9sbCgpIHtcblx0XHRpZihjb25uZWN0aW9uUG9vbCkge1xuXHRcdFx0Y29ubmVjdGlvblBvb2wuZW5kKChlcnIpID0+IHtcblx0XHRcdFx0Ly8gY29uc29sZS5sb2coXCJjb25uZWN0aW9uUG9vbCBkZXN0cm95ZWRcIik7XG5cdFx0XHRcdGNvbm5lY3Rpb25Qb29sID0gbnVsbDtcblx0XHRcdH0pO1xuXHRcdH1cblx0fVxufVxuXG5cbmV4cG9ydCBkZWZhdWx0IE15c3FsRGF0YWJhc2UyO1xuXG4iXX0=
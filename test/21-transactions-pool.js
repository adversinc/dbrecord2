require('source-map-support').install();

process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config"),
	lodashMerge = require('lodash/merge'),
	mlog = require('mocha-logger');

// Libs to test
const MysqlDatabase = require("../lib/MysqlDatabase2");
const TestRecord = require('./classes/TestRecord');

const sleep = function(ms) {
	return new Promise((resolve, reject) => {
		setTimeout(function() {
			resolve();
		}, ms);
	});
};

MysqlDatabase.debugLogTransactions = true;

// Tests
describe('DbRecord2 transactions pool', function() {
	let dbh = null;

	before(async function() {
		const c = lodashMerge({}, config.get("mysql"));
		// Should be at least 3: one main connection, and 1 for each thread in test
		if(c.connectionLimit < 3) {
			mlog.log("c.connectionLimit increased to 3");
			c.connectionLimit = 3;
		}

		await MysqlDatabase.setupPool(c);
		dbh = await MysqlDatabase.masterDbh({ logger: mlog });
	});
	beforeEach(async function() {
		await TestRecord.createMockTable(dbh);
	});

	after(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should save committed', async function() {
		await TestRecord.createMockTable(dbh);

		let objId = null;
		await dbh.execTransaction(async(dbh) => {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle());
			await obj.commit();

			objId = obj.id();
		});

		let exists = true;
		try {
			const obj2 = new TestRecord({id: objId});
			await obj2.init();
		} catch(ex) {
			if(ex == "E_DB_NO_OBJECT") {
				exists = false;
			} else {
				throw ex;
			}
		}

		assert.ok(exists, "Object should exist");
	});

	//
	//
	it('should remove uncommitted', async function() {
		let objId = null;
		await dbh.execTransaction(async (dbh) => {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle());
			await obj.commit();

			objId = obj.id();
			return false;
		});

		assert.ok(await TestRecord.tryCreate({ id: objId }) === null, "Object should not exist");
	});

	//
	//
	it('should not intersect', async function() {
		let rowsFound = null;

		await dbh.queryAsync("INSERT INTO dbrecord_test SET name=?",
			[ 'main thread' ]);

		// Start thread 2 which waits 500ms. Then checks how many records there are
		// in a table. Should be 1 if transaction separation works.
		const thread2 = async function() {
			await dbh.execTransaction(async (dbh) => {
				await sleep(500);
				mlog.log("thread 2 starting");

				const res = await dbh.getRow("SELECT COUNT(*) cnt FROM dbrecord_test");
				rowsFound = res.cnt;
				mlog.log("thread 2 rows found:", rowsFound);

				mlog.log("thread 2 exiting");
			});
		};

		thread2();

		// Start thread 1 which will insert 1 record immediately and then sleep
		// for 1000ms
		await dbh.execTransaction(async (dbh) => {
			mlog.log("thread 1 starting");
			await dbh.queryAsync("INSERT INTO dbrecord_test SET name=?, field2=?",
				[ 'thread 1 ', Math.random()*1000000 ]);

			mlog.log("thread 1 has added a 2nd record");
			await sleep(1000);
			mlog.log("thread 1 exiting");
		});

		await sleep(1000);

		// Checks
		assert.equal(rowsFound, 1, "No trx overlap found");
	});

	//
	//
	it('should throw when object updated inside wrong transaction', async function() {
		let objId = null;

		const obj = new TestRecord();
		await obj.init();
		obj.name(this.test.fullTitle());
		await obj.commit();

		// The trx which will thrown an exception
		const p = dbh.execTransaction(async (dbh) => {
			obj.name("Something else");
			await obj.commit();
		});

		await assert.rejects(p, {
			message: 'TestRecord: Object has to be re-created in transaction',
		});
	});
});


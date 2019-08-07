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

// Tests
describe('DbRecord transactions', function() {
	let dbh = null;
	before(async function() {
		const c = lodashMerge({}, config.get("mysql"));
		c.reuseConnection = true;
		c.logger = mlog;

		MysqlDatabase.masterConfig(c);
		dbh = await MysqlDatabase.masterDbh();
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
		await dbh.execTransaction(async (dbh) => {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle());
			await obj.commit();

			objId = obj.id();
		});

		let exists = true;
		try {
			const obj2 = new TestRecord({id: objId});
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
		//dbh._db.on('enqueue', function(sequence) {
		//	mlog.log("QUERY: ", sequence.sql);
		//});

		await TestRecord.createMockTable(dbh);

		let objId = null;
		dbh._config.logger = mlog;
		await dbh.execTransaction(async (dbh) => {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle());
			await obj.commit();

			objId = obj.id();

			return false;
		});

		const obj2 = await TestRecord.tryCreate({ id: objId });
		assert.ok(obj2 === null, "Object should not exist");
	});


	//
	//
	it('should intersect on single connection', async function() {
		let rowsFound = null;

		// Start thread 2 which waits 500ms and then checks how many records there are
		// in a table. Should be 0 for a normal transaction, but we expect 1 here
		// since we share a single connection
		const thread2 = async function() {
			await dbh.execTransaction(async (dbh) => {
				await sleep(500);
				mlog.log("thread 2 starting");

				const res = await dbh.getRow("SELECT COUNT(*) cnt FROM dbrecord_test");
				rowsFound = res.cnt;
				mlog.log("thread 2 res: ", res);

				mlog.log("thread 2 exiting");
			});
		};

		thread2();

		// Start thread 1 which will insert 1 record immediately and then sleep
		// for 1000ms
		await dbh.execTransaction(async (dbh) => {
			mlog.log("thread 1 starting");
			await dbh.queryAsync("INSERT INTO dbrecord_test SET name='thread 1'");
			await sleep(1000);
			mlog.log("thread 1 exiting");
		});

		await sleep(1000);
		mlog.log("tests completed");

		// Checks
		assert.equal(rowsFound, 1, "Found trx overlap");
	});
});


// Tests
describe('DbRecord2 transactionWithMe', function() {
	let dbh = null;
	before(async function() {
		const c = lodashMerge({}, config.get("mysql"));
		c.reuseConnection = true;
		c.logger = mlog;

		MysqlDatabase.masterConfig(c);
		dbh = await MysqlDatabase.masterDbh();
	});

	beforeEach(async function() {
		await TestRecord.createMockTable(dbh);
	});

	after(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should work inside trx', async function() {
		const obj = new TestRecord();
		await obj.init();
		obj.name(this.test.fullTitle());
		await obj.commit();

		let originalName = "was not called at all";

		await obj.transactionWithMe(async(obj) => {
			console.log("In TRX:", obj.name());
			originalName = obj.name();

			obj.name("Changed to new");
			await obj.commit();
		});

		assert.equal(originalName, this.test.fullTitle());
		assert.equal(obj.name(), "Changed to new");
	});

	it('should rollback trx if required', async function() {
		const obj = new TestRecord();
		await obj.init();
		obj.name(this.test.fullTitle());
		await obj.commit();

		let originalName = "was not called at all";

		await obj.transactionWithMe(async(obj) => {
			console.log("In TRX:", obj.name());
			originalName = obj.name();

			obj.name("Changed to new");
			await obj.commit();

			return false;
		});

		assert.equal(originalName, this.test.fullTitle());
		assert.equal(obj.name(), this.test.fullTitle());
	});
});

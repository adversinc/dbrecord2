process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config"),
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
describe('DbRecord record iteration', function() {
	let dbh = null;
	before(async function() {
		MysqlDatabase.masterConfig(config.get("mysql"));
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
	it('should go through all rows', async function() {
		// Create records
		const source = [];
		for(let i = 0; i < 5; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			await obj.commit();
		}

		// Checks
		const res = [];
		await TestRecord.forEach({ DEBUG_SQL_QUERY: 1 }, (itm, options) => {
			res.push({ id: itm.id(), name: itm.name() });
			console.log("pushed", { id: itm.id(), name: itm.name() });
		});

		assert.deepEqual(res, [
			{ id: 1, name: "DbRecord record iteration should go through all rows#0" },
			{ id: 2, name: "DbRecord record iteration should go through all rows#1" },
			{ id: 3, name: "DbRecord record iteration should go through all rows#2" },
			{ id: 4, name: "DbRecord record iteration should go through all rows#3" },
			{ id: 5, name: "DbRecord record iteration should go through all rows#4" },
		]);
	});

	//
	//
	it('should use ORDERBY', async function() {
		// Create records
		const source = [];
		for(let i = 0; i < 5; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			await obj.commit();
		}

		// Checks
		const res = [];
		await TestRecord.forEach({ ORDERBY: "id DESC" }, (itm, options) => {
			res.push({ id: itm.id(), name: itm.name() });
		});

		assert.deepEqual(res, [
			{ id: 5, name: "DbRecord record iteration should use ORDERBY#4" },
			{ id: 4, name: "DbRecord record iteration should use ORDERBY#3" },
			{ id: 3, name: "DbRecord record iteration should use ORDERBY#2" },
			{ id: 2, name: "DbRecord record iteration should use ORDERBY#1" },
			{ id: 1, name: "DbRecord record iteration should use ORDERBY#0" },
		]);
	});

	//
	//
	it('should use limits', async function() {
		// Create records
		const source = [];
		for(let i = 0; i < 5; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			await obj.commit();
		}

		// Checks
		const res = [];
		await TestRecord.forEach({ LIMIT: 1 }, (itm, options) => {
			res.push({ id: itm.id(), name: itm.name() });
		});

		assert.deepEqual(res, [
			{ id: 1, name: "DbRecord record iteration should use limits#0" },
		]);
	});

	//
	//
	it('should use complex limits', async function() {
		// Create records
		const source = [];
		for(let i = 0; i < 5; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			await obj.commit();
		}

		// Checks
		const res = [];
		await TestRecord.forEach({ LIMIT: "2,1" }, (itm, options) => {
			res.push({ id: itm.id(), name: itm.name() });
		});

		assert.deepEqual(res, [
			{ id: 3, name: "DbRecord record iteration should use complex limits#2" },
		]);
	});

	//
	//
	it('should go through with field filter', async function() {
		// Create records
		const source = [];
		for(let i = 0; i < 5; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			obj.field2(i);
			await obj.commit();
		}

		// Checks
		const res = [];
		await TestRecord.forEach({ field2: 2, DEBUG_SQL_QUERY: 1 }, (itm, options) => {
			res.push({ id: itm.id(), name: itm.name(), field2: itm.field2() });
		});

		assert.deepEqual(res, [
			{ id: 3, name: "DbRecord record iteration should go through with field filter#2", field2: 2 },
		]);
	});

	it('should catch the iterator exception', async function() {
// Create records
		const source = [];
		for(let i = 0; i < 5; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			obj.field2(i);
			await obj.commit();
		}

		// Checks
		let gotException = "";
		const ERROR = "Error in iterator";
		try {
			await TestRecord.forEach({
				field2: 2,
				DEBUG_SQL_QUERY: 1
			}, async (itm, options) => {
				throw new Error(ERROR);
			});
		} catch(ex) {
			gotException = ERROR;
		}

		assert.equal(gotException, ERROR);
	});

	it('should run wait for each iterator', async function() {
		// Create records
		const source = [];
		for(let i = 0; i < 2; i++) {
			const obj = new TestRecord();
			await obj.init();

			obj.name(this.test.fullTitle() + "#" + i);
			obj.field2(i);
			await obj.commit();
		}

		// Go through all records, and make a delay so FIRST item has a LONGEST
		// delay
		let insideIterator = false;
		let doubleInside = false;

		await TestRecord.forEach({
		}, async (itm, options) => {
			if(insideIterator) { doubleInside = true; }
			insideIterator = true;
			await sleep(1000);
			insideIterator = false;
		});

		assert.equal(doubleInside, false, "forEach waits for iterator to end");
	});

});


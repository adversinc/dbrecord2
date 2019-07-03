process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config");

// Libs to test
const MysqlDatabase = require("../lib/MysqlDatabase2");
const TestRecord = require('./classes/TestRecord');

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

});


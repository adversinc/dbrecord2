import {describe, before, after, beforeEach, it} from "mocha";

process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config"),
	mlog = require('mocha-logger');

// Libs to test
const MysqlDatabase = require("../src/MysqlDatabase2");
const TestRecord = require('./classes/TestRecord');

// Tests
describe('DbRecord2 managed fields', function() {
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
	it('should use overloaded field', async function() {
		const obj = new TestRecord();
		await obj.init();

		obj.name(this.test.fullTitle());
		obj.managed_field("test");
		await obj.commit();

		assert.deepEqual(
			{ called: obj._managedCalled },
			{ called: true }
		);
	});


});


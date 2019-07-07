process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config");

// Libs to test
const MysqlDatabase = require("../lib/MysqlDatabase2");

// Tests
describe('MysqlDatabase2 basic ops', function() {
	let dbh = null;
	before(async function() {
		MysqlDatabase.masterConfig(config.get("mysql"));

		dbh = await MysqlDatabase.masterDbh();
	});

	after(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should throw on broken SQL', async function() {
		const sql = "BROKEN_SELECT *";


		await assert.rejects(async () => {
			const res = await dbh.queryAsync(sql);
		});
	});
});


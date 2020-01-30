process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config");

// Libs to test
const MysqlDatabase = require("../lib/MysqlDatabase2");
console.log("MysqlDatabase=", MysqlDatabase);

// Tests
describe('MysqlDatabase2 connection', function() {
	after(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should throw on wrong credentials', async function() {
		MysqlDatabase.masterConfig({
			host: "localhost",
			user: "user never existed",
			password: "password2password"
		});


		await assert.rejects(async() => {
				await MysqlDatabase.masterDbh();
			},
			{
				code: "ER_ACCESS_DENIED_ERROR"
			});
	});
});

describe('MysqlDatabase2 pool connection', function() {
	after(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should throw on wrong credentials', async function() {
		const config = {
			host: "localhost",
			user: "user never existed",
			password: "password2password",
			connectionLimit: 3
		};

		await MysqlDatabase.setupPool(config);

		await assert.rejects(async() => {
				await MysqlDatabase.masterDbh();
			},
			{
				code: "ER_ACCESS_DENIED_ERROR"
			});
	});
});


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


	//
	//
	it('should have utf8mb4 charset', async function() {
		const res = await dbh.getRow("SHOW VARIABLES LIKE 'character_set_client'");
		assert.strictEqual(res.Value, "utf8mb4");
	});
});


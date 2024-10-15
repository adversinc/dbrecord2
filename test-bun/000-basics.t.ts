import {describe, afterAll, beforeAll, it, expect} from "@jest/globals";

process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
import assert from 'assert';
import config from "config";

// Libs to test
import MysqlDatabase from "../src/MysqlDatabase2";

// Tests
describe('MysqlDatabase2 connection', function() {
	console.log("In describe 1");

	afterAll(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should throw on wrong credentials', async function() {
		console.log("T1 start");
		MysqlDatabase.masterConfig({
			host: "localhost",
			user: "user never existed",
			password: "password2password"
		});

		expect(MysqlDatabase.masterDbh()).rejects.toThrow();

		/*
		await assert.rejects(async() => {
				await MysqlDatabase.masterDbh();
			},
			{
				code: "ECONNREFUSED" // "ER_ACCESS_DENIED_ERROR"
			});

		 */

		console.log("T1 end");
	});
});

describe('MysqlDatabase2 pool connection', function() {
	afterAll(() => {
		MysqlDatabase.masterDbhDestroy();
	});

	//
	//
	it('should throw on wrong pool credentials', async function() {
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
				code: "ECONNREFUSED" // "ER_ACCESS_DENIED_ERROR"
			});
	});
});


describe('MysqlDatabase2 basic ops', function() {
	console.log("In describe 2");

	let dbh = null;
	beforeAll(async function() {
		console.log("In beforeAll 2");
		MysqlDatabase.masterConfig(config.get("mysql"));

		dbh = await MysqlDatabase.masterDbh();
	});

	afterAll(() => {
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


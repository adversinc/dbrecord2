process.env["NODE_CONFIG_DIR"] = __dirname + "/config/";
const
	assert = require('assert'),
	config = require("config");

// Libs to test
const MysqlDatabase = require("../lib/MysqlDatabase2");
const TestRecord = require('./classes/TestRecord');

// Tests
describe('DbRecord2 basic ops', function() {
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
	it('should create a row', async function() {
		const obj = new TestRecord();
		await obj.init();
		obj.name(this.test.fullTitle());
		await obj.commit();

		// Checks
		const TABLE_NAME  = obj._tableName;
		const row = await dbh.queryAsync(`SELECT * FROM ${TABLE_NAME}`);
		assert.deepEqual(row, [ {
			id: 1,
			name: this.test.fullTitle(),
			field2: null,
			field3: null,
			managed_field: null
		} ]);
	});

	//
	//
	it('should create a row with newRecord', async function() {
		const obj = await TestRecord.newRecord({
			name: this.test.fullTitle()
		});

		// Checks
		const TABLE_NAME  = obj._tableName;
		const row = await dbh.queryAsync(`SELECT * FROM ${TABLE_NAME}`);
		assert.deepEqual(row, [ {
			id: 1,
			name: this.test.fullTitle(),
			field2: null,
			field3: null,
			managed_field: null
		} ]);
	});

	//
	//
	it('should create a row with newRecord with id', async function() {
		const obj = await TestRecord.newRecord({
			id: 123,
			name: this.test.fullTitle()
		});

		// Checks
		const TABLE_NAME  = obj._tableName;
		const row = await dbh.queryAsync(`SELECT * FROM ${TABLE_NAME}`);
		assert.deepEqual(row, [ {
			id: 123,
			name: this.test.fullTitle(),
			field2: null,
			field3: null,
			managed_field: null
		} ]);
	});

	//
	//
	it('should fail on unexistent row', async function() {
		let error = {};
		try {
			let obj = new TestRecord({id: 1});
			await obj.init();
			// console.log("obj:", obj);
		} catch(ex) {
			error = ex;
		}

		assert.equal(error.message, "E_DB_NO_OBJECT");
	});

	//
	//
	it('should fail on undefined primary key', async function() {
		let error = {};

		await assert.rejects(async() => {
			let obj = new TestRecord({id: undefined});
			await obj.init();
		}, {
			message: "E_DB_NO_OBJECT"
		});
	});

	//
	//
	it('should get created on existing row', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET id=10,name=?`, [this.test.fullTitle()]);

		const obj = new TestRecord({ id: 10 });
		await obj.init();

		assert.equal(obj.name(), this.test.fullTitle());
	});

	//
	//
	it('should get created by secondary key', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?`, [ Math.random(), 100 ]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?`, [this.test.fullTitle(), 200]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?`, [ Math.random(), 300 ]);

		const obj = new TestRecord({ field2: 200 });
		await obj.init();

		assert.deepEqual(
			{ name: obj.name(), field2: obj.field2() },
			{ name: this.test.fullTitle(), field2: 200 }
		);
	});

	//
	//
	it('should fail by unexisting secondary key', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?`, [ Math.random(), 100 ]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?`, [this.test.fullTitle(), 200]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?`, [ Math.random(), 300 ]);

		let error = {};
		try {
			let obj = new TestRecord({ field2: 10000 });
			await obj.init();
		} catch(ex) {
			error = ex;
		}

		assert.equal(error.message, "E_DB_NO_OBJECT");
	});

	//
	//
	it('should fail on undefined secondary key', async function() {
		let error = {};

		await assert.rejects(async() => {
			let obj = new TestRecord({field2: undefined});
			await obj.init();
		}, {
			message: "E_DB_NO_OBJECT"
		});
	});
	//
	//
	it('should get created by complex secondary key', async function() {
		// IMPORTANT: the test relies on a row insertion order (the row inserted
		// first is supposed to be returned with LIMIT 1
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[ Math.random(), 100, "First" ]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[this.test.fullTitle(), 200, "Second"]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[this.test.fullTitle(), 200, "Third"]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[ Math.random(), 300, "Fourth" ]);

		const obj = new TestRecord({ field2: 200, field3: "Third" });
		await obj.init();

		assert.deepEqual(
			{ name: obj.name(), field2: obj.field2(), field3: obj.field3() },
			{ name: this.test.fullTitle(), field2: 200, field3: "Third" }
		);
	});

	//
	//
	it('should fail by unexisting complex secondary key', async function() {
		// IMPORTANT: the test relies on a row insertion order (the row inserted
		// first is supposed to be returned with LIMIT 1
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[ Math.random(), 100, "First" ]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[this.test.fullTitle(), 200, "Second"]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[this.test.fullTitle(), 200, "Third"]);
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET name=?, field2=?, field3=?`,
			[ Math.random(), 300, "Fourth" ]);

		let error = {};
		try {
			let obj = new TestRecord({ field2: 200, field3: "One hundreds" });
			await obj.init();
		} catch(ex) {
			error = ex;
		}

		assert.equal(error.message, "E_DB_NO_OBJECT");
	});

	//
	//
	it('should create in tryCreate', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET id=3,name=?`, [this.test.fullTitle()]);

		let obj = await TestRecord.tryCreate({ id: 3 });

		assert.ok(obj !== null);
		assert.equal(obj.name(), this.test.fullTitle());
	});

	//
	//
	it('should fail in tryCreate for nonexistant', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET id=3,name=?`, [this.test.fullTitle()]);

		let obj = await TestRecord.tryCreate({ id: 3000 });

		assert.ok(obj === null);
	});

	//
	//
	it('should remove itself', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET id=3,name=?`, [this.test.fullTitle()]);

		let obj = await TestRecord.tryCreate({ id: 3 });
		assert.ok(obj !== null);

		await obj.deleteRecord();

		let obj2 = await TestRecord.tryCreate({ id: 3 });
		assert.ok(obj2 === null);
	});

	//
	//
	it('should accept commit with no changes', async function() {
		await dbh.queryAsync(`INSERT INTO dbrecord_test SET id=3,name=?`, [this.test.fullTitle()]);

		let obj = await TestRecord.tryCreate({ id: 3 });
		assert.ok(obj !== null);

		await assert.doesNotReject( async () => {
			await obj.commit();
		});
	});
});


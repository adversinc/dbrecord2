import DbRecord2 = require("../src/DbRecord2");

class TestRecord extends DbRecord2 {
	static _table() {
		return "tests.table";
	}

	static _locatefield() {
		return "id";
	}

	static _keys() {
		return ["field2", "field2,field3", "name,field2,field3"];
	}

	myLocal() {}
}

// The 'item' type should resolve to "TestRecord" with TS
TestRecord.forEach({

}, async (item) => {
	item.myLocal();
})
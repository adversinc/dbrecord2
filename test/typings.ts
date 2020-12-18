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

// 1. The 'item' type should resolve to "TestRecord" with TS
TestRecord.forEach({

}, async (item) => {
	item.myLocal();
})

// 2. Enum/Set should be extensible
type T_YN = "Y"|"N";

const a: DbRecord2.Column.Enum = (v: string) => { return v; };
const a1: DbRecord2.Column.Enum<T_YN> = (v: T_YN) => { return v; };
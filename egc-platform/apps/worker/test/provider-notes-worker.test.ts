import {describe,it,expect} from 'vitest';
import {validatedContactNotes} from '../src/provider-notes-worker.js';
describe('provider contact notes evidence boundary',()=>{
 it('accepts a complete empty provider read and exact customer notes',()=>{expect(validatedContactNotes({notes:[]},'c')).toEqual([]);expect(validatedContactNotes({notes:[{id:'n',body:'The customer accepted the quoted work.',contactId:'c',dateAdded:'2026-09-21T12:00:00Z'}]},'c')).toHaveLength(1);});
 it.each([{}, {notes:{}}, {notes:[],hasMore:true},{notes:[{id:'n',body:'other customer',contactId:'different'}]},{notes:[{id:'n'}]},{notes:[{id:'n',body:'a'},{id:'n',body:'b'}]}])('refuses malformed, incomplete or conflicting identity %s',payload=>{expect(()=>validatedContactNotes(payload,'c')).toThrow();});
});

import {listSpendEntries,readSpendCoverage,recordSpendEntry,SpendLedgerError,voidSpendEntry,type Queryable} from "@egc/ad-spend";
import {OperationsError,type Actor,type Command} from "./contracts.js";
import {isSpendCommand} from "./spend-commands.js";

type SpendCommand = Extract<Command,{command:"spend.entry.record"|"spend.entry.void"|"spend.entries"|"spend.coverage"}>;
export const isSpendRequest = (command:Command):command is SpendCommand => isSpendCommand(command.command);
const mapped = async <T,>(work:()=>Promise<T>):Promise<T> => {
  try {return await work();}
  catch(error){if(error instanceof SpendLedgerError)throw new OperationsError(error.code,error.status,error.details);throw error;}
};
/** Runs inside the service's read-only REPEATABLE READ transaction (one snapshot). */
export function spendRead(tx:Queryable,actor:Actor,command:SpendCommand,now:Date):Promise<Record<string,unknown>> {
  if(command.command==="spend.coverage")return mapped(()=>readSpendCoverage(tx,actor,{from:command.from,to:command.to},now));
  if(command.command==="spend.entries")return mapped(()=>listSpendEntries(tx,actor,command));
  throw new OperationsError("unsupported_read",400);
}
/** Runs inside the service's write transaction, together with its idempotency receipt. */
export function spendWrite(tx:Queryable,actor:Actor,command:SpendCommand,requestId:string,now:Date):Promise<Record<string,unknown>> {
  if(command.command==="spend.entry.record")return mapped(()=>recordSpendEntry(tx,actor,{entry:command.entry,supersedes:command.supersedes},requestId,now));
  if(command.command==="spend.entry.void")return mapped(()=>voidSpendEntry(tx,actor,command,now));
  throw new OperationsError("unsupported_write",400);
}

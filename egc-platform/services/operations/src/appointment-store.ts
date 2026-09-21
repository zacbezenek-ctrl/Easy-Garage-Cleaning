import {and,eq,inArray,ne,sql} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
import {AppointmentOperationError,type AppointmentIntent,type AppointmentOperation,type AppointmentStore} from "./appointment-reliability.js";

type Db=ReturnType<typeof getDb>;
type Row=typeof schema.appointmentOperations.$inferSelect;
const operation=(row:Row):AppointmentOperation=>({...row,kind:row.kind as AppointmentOperation["kind"],status:row.status as AppointmentOperation["status"]});

/** Claims and resource conflict checks share one PostgreSQL transaction. A stale
 * lease is never permission to send again: it is an unknown provider outcome. */
export function postgresAppointmentStore(db:Db=getDb()):AppointmentStore {
  return {
    async reserve(intent:AppointmentIntent) {
      await db.insert(schema.appointmentOperations).values(intent).onConflictDoNothing({target:schema.appointmentOperations.operationKey});
      const [row]=await db.select().from(schema.appointmentOperations).where(eq(schema.appointmentOperations.operationKey,intent.operationKey)).limit(1);
      if(!row)throw new AppointmentOperationError("appointment_operation_not_persisted");
      if(row.payloadHash!==intent.payloadHash||row.kind!==intent.kind||row.resourceKey!==intent.resourceKey)throw new AppointmentOperationError("appointment_idempotency_payload_conflict",row.id);
      return operation(row);
    },
    async get(id) {
      const [row]=await db.select().from(schema.appointmentOperations).where(eq(schema.appointmentOperations.id,id)).limit(1);
      return row?operation(row):null;
    },
    async claim(op,now) {
      return db.transaction(async tx=>{
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`appointment:${op.resourceKey}`},0))`);
        const [conflict]=await tx.select({id:schema.appointmentOperations.id}).from(schema.appointmentOperations).where(and(
          eq(schema.appointmentOperations.resourceKey,op.resourceKey),ne(schema.appointmentOperations.id,op.id),
          inArray(schema.appointmentOperations.status,op.kind==="create"&&op.resourceKey.startsWith("create:portal:")?["in_flight","unknown","accepted"]:["in_flight","unknown"]))).limit(1);
        if(conflict)throw new AppointmentOperationError("appointment_resource_has_unresolved_operation",conflict.id);
        const [claimed]=await tx.update(schema.appointmentOperations).set({status:"in_flight",attemptCount:sql`${schema.appointmentOperations.attemptCount}+1`,
          lastAttemptAt:now,leaseExpiresAt:new Date(now.valueOf()+120000),updatedAt:now,lastError:null})
          .where(and(eq(schema.appointmentOperations.id,op.id),inArray(schema.appointmentOperations.status,["pending","failed"]))).returning({id:schema.appointmentOperations.id});
        return Boolean(claimed);
      });
    },
    async finish(id,status,data) {
      const [updated]=await db.update(schema.appointmentOperations).set({status,...data,updatedAt:new Date(),
        ...(status==="in_flight"?{}:{leaseExpiresAt:null}),...(status==="accepted"?{lastError:null}:{})})
        .where(and(eq(schema.appointmentOperations.id,id),status==="accepted"?undefined:ne(schema.appointmentOperations.status,"accepted"))).returning({id:schema.appointmentOperations.id});
      // A concurrent successful read must not be overwritten by a stale timeout.
      if(!updated&&status==="accepted")throw new AppointmentOperationError("appointment_operation_not_persisted",id);
    }
  };
}

import { getCustomers } from "../../lib/data";
import {portalTime} from "../../lib/format";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const rows = await getCustomers();
  return (
    <>
      <h1>Customers</h1>
      <p className="muted">Unified contacts synchronized into the EGC operational layer.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Source</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map((contact) => (
              <tr key={contact.id}>
                <td><a className="tablelink" href={"/customers/" + contact.id}>{contact.name ?? "Unknown"}</a></td>
                <td>{contact.phone ?? "—"}</td>
                <td>{contact.email ?? "—"}</td>
                <td>{contact.source ?? "—"}</td>
                <td>{portalTime(contact.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

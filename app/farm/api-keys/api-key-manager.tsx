"use client";
import { useEffect, useState } from "react";

interface KeyRow { id: string; name: string; prefix: string; scopes: string[]; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null }

export function ApiKeyManager() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const response = await fetch("/api/farm/api-keys", { cache: "no-store" });
    const result = await response.json();
    if (response.ok) setKeys(result.keys); else setMessage(result.error);
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setMessage(""); setToken("");
    const response = await fetch("/api/farm/api-keys", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scopes: ["supplier-batch:write", "supplier-batch:read"], ttlDays: 90 })
    });
    const result = await response.json();
    if (!response.ok) { setMessage(result.error); return; }
    setToken(result.key.token); setName(""); await load();
  }

  async function revoke(id: string) {
    const response = await fetch("/api/farm/api-keys?id=" + encodeURIComponent(id), { method: "DELETE" });
    const result = await response.json();
    setMessage(response.ok ? "Key revoked." : result.error);
    await load();
  }

  return (
    <div className="panel">
      <div className="formActions">
        <label>Key name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="herd-system-prod" /></label>
        <button className="primaryButton" type="button" disabled={name.trim().length < 3} onClick={create}>Create 90-day key</button>
      </div>
      {token && <div className="privacyBanner"><strong>Copy this token now — it is not shown again.</strong><code style={{ wordBreak: "break-all" }}>{token}</code></div>}
      <p role="status">{message}</p>
      <div className="tableScroll"><table className="dataTable">
        <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Expires</th><th>Last used</th><th>Status</th><th /></tr></thead>
        <tbody>{keys.map((key) => (
          <tr key={key.id}>
            <td>{key.name}</td><td><code>{key.prefix}</code></td><td>{key.scopes.join(", ")}</td>
            <td>{key.expiresAt.slice(0, 10)}</td><td>{key.lastUsedAt?.slice(0, 16) ?? "never"}</td>
            <td>{key.revokedAt ? "revoked" : "active"}</td>
            <td>{!key.revokedAt && <button className="secondaryButton" type="button" onClick={() => revoke(key.id)}>Revoke</button>}</td>
          </tr>))}
        </tbody>
      </table></div>
    </div>
  );
}

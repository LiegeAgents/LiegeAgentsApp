import React, { useEffect, useState } from "react";
import { BellOff } from "lucide-react";
import { Notice } from "./UI";
import { api } from "./api";

/**
 * Notification preferences. Each category can be muted; a muted notification is never stored, so
 * it skips the inbox and the mobile feed alike. Disputes and low-balance alerts always arrive.
 */
export default function NotificationSettings({ token }) {
  const [items, setItems] = useState(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(null);
  useEffect(() => {
    api
      .notificationPreferences(token)
      .then((result) => setItems(result.data))
      .catch(() => setItems(null));
  }, [token]);
  if (!items) return null;
  const toggle = async (category, muted) => {
    const next = items
      .filter((item) => (item.category === category ? muted : item.muted))
      .map((item) => item.category);
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.setNotificationPreferences(token, next);
      setItems(result.data);
      const label = items.find((item) => item.category === category)?.label;
      setMessage({ text: muted ? `${label} muted.` : `${label} back on.` });
    } catch (e) {
      setMessage({ error: true, text: e?.message || "That did not work. Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-panel notification-settings">
      <h2>
        <BellOff size={16} /> Notifications
      </h2>
      <p>
        Choose what lands in your inbox. Muting stops new notifications of that kind; ones you
        already have stay. Disputes and low-balance alerts always come through.
      </p>
      <ul className="notification-categories">
        {items.map((item) => (
          <li key={item.category}>
            <label>
              <input
                type="checkbox"
                checked={!item.muted}
                disabled={busy}
                onChange={(e) => toggle(item.category, !e.target.checked)}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {message && <Notice error={message.error}>{message.text}</Notice>}
    </div>
  );
}

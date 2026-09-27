import "./App.css";
import { useState } from "react";

const getSessionId = () => {
  let sessionId = localStorage.getItem("leadflow-session");

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("leadflow-session", sessionId);
  }

  return sessionId;
};

function App() {
  const [sessionId] = useState(getSessionId);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [page, setPage] = useState("chat");
  const [leads, setLeads] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(
    localStorage.getItem("leadflow-token") || ""
  );

  const totalLeads = leads.length;
  const newLeads = leads.filter((lead) => lead.status === "new").length;
  const contactedLeads = leads.filter(
    (lead) => lead.status === "contacted"
  ).length;
  const qualifiedLeads = leads.filter(
    (lead) => lead.status === "qualified"
  ).length;
  const closedLeads = leads.filter(
    (lead) => lead.status === "closed"
  ).length;

  const filteredLeads = leads.filter((lead) => {
    const matchesStatus =
      statusFilter === "all" || lead.status === statusFilter;

    const search = searchTerm.toLowerCase();
    const matchesSearch =
      (lead.name || "").toLowerCase().includes(search) ||
      (lead.email || "").toLowerCase().includes(search) ||
      (lead.service || "").toLowerCase().includes(search);

    return matchesStatus && matchesSearch;
  });

  const sendMessage = async () => {
    if (!input.trim() || chatLoading) return;

    const currentInput = input;
    setMessages((old) => [...old, `Du: ${currentInput}`]);
    setInput("");
    setChatLoading(true);
    setError("");

    try {
      const response = await fetch("http://localhost:5000/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: currentInput,
          sessionId,
        }),
      });

      if (!response.ok) {
        throw new Error("Could not send message");
      }

      const data = await response.text();
      setMessages((old) => [...old, data]);
    } catch (err) {
      console.error(err);
      setError("Could not send message.");
    } finally {
      setChatLoading(false);
    }
  };

  const loadLeads = async (authToken = token) => {
    setDashboardLoading(true);
    setError("");

    try {
      const response = await fetch("http://localhost:5000/leads", {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem("leadflow-token");
        setToken("");
        setLeads([]);
        setPage("dashboard");
        setError("Sessionen har gått ut. Logga in igen.");
        return;
      }

      if (!response.ok) {
        throw new Error("Could not load leads");
      }

      const data = await response.json();
      setLeads(data);
      setPage("dashboard");
    } catch (err) {
      console.error(err);
      setError("Could not load leads.");
    } finally {
      setDashboardLoading(false);
    }
  };

  const login = async () => {
    if (!email || !password || dashboardLoading) return;

    setDashboardLoading(true);
    setError("");

    try {
      const response = await fetch("http://localhost:5000/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      if (response.status === 401) {
        setError("Fel email eller lösenord.");
        return;
      }

      if (!response.ok) {
        throw new Error("Login failed");
      }

      const data = await response.json();

      localStorage.setItem("leadflow-token", data.token);
      setToken(data.token);
      setPassword("");
      await loadLeads(data.token);
    } catch (err) {
      console.error(err);
      setError("Kunde inte logga in. Kontrollera att backend körs.");
    } finally {
      setDashboardLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem("leadflow-token");
    setToken("");
    setLeads([]);
    setEmail("");
    setPassword("");
    setError("");
    setPage("chat");
  };

  const updateLeadStatus = async (leadId, newStatus) => {
    try {
      const response = await fetch(
        `http://localhost:5000/leads/${leadId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: newStatus }),
        }
      );

      if (!response.ok) {
        throw new Error("Could not update lead");
      }

      const updatedLead = await response.json();

      setLeads((old) =>
        old.map((lead) =>
          lead._id === updatedLead._id ? updatedLead : lead
        )
      );
    } catch (err) {
      console.error(err);
      setError("Kunde inte uppdatera lead.");
    }
  };

  const deleteLead = async (leadId) => {
    try {
      const response = await fetch(
        `http://localhost:5000/leads/${leadId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Could not delete lead");
      }

      setLeads((old) =>
        old.filter((lead) => lead._id !== leadId)
      );
    } catch (err) {
      console.error(err);
      setError("Kunde inte ta bort lead.");
    }
  };

  return (
    <div className="app">
      <h1>LeadFlow AI</h1>

      <nav>
        <button onClick={() => { setPage("chat"); setError(""); }}>
          Chat
        </button>

        <button
          onClick={() => {
            setError("");
            if (token) {
              loadLeads();
            } else {
              setPage("dashboard");
            }
          }}
        >
          Dashboard
        </button>

        {token && (
          <button onClick={logout}>
            Logout
          </button>
        )}
      </nav>

      {page === "chat" && (
        <div className="chat-section">
          <h2>AI Chat</h2>

          {chatLoading && <p>AI is thinking...</p>}
          {error && <p>{error}</p>}

          <input
            type="text"
            placeholder="Skriv ett meddelande..."
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                sendMessage();
              }
            }}
          />

          <button onClick={sendMessage} disabled={chatLoading}>
            Skicka
          </button>

          <div>
            {messages.map((text, index) => (
              <p key={index}>{text}</p>
            ))}
          </div>
        </div>
      )}

      {page === "dashboard" && !token && (
        <div className="login-section">
          <h2>Admin Login</h2>

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") login();
            }}
          />

          <button onClick={login} disabled={dashboardLoading}>
            {dashboardLoading ? "Logging in..." : "Login"}
          </button>

          {error && <p>{error}</p>}
        </div>
      )}

      {page === "dashboard" && token && (
        <div className="dashboard">
          <h2>Leads</h2>

          {dashboardLoading && <p>Loading leads...</p>}
          {error && <p>{error}</p>}

          <div className="stats">
            <div className="stat-card">
              <h3>Total Leads</h3>
              <p>{totalLeads}</p>
            </div>

            <div className="stat-card">
              <h3>New</h3>
              <p>{newLeads}</p>
            </div>

            <div className="stat-card">
              <h3>Contacted</h3>
              <p>{contactedLeads}</p>
            </div>

            <div className="stat-card">
              <h3>Qualified</h3>
              <p>{qualifiedLeads}</p>
            </div>

            <div className="stat-card">
              <h3>Closed</h3>
              <p>{closedLeads}</p>
            </div>
          </div>

          <div className="filter-box">
            <label>Search leads</label>

            <input
              type="text"
              placeholder="Search leads..."
              value={searchTerm}
              onChange={(event) =>
                setSearchTerm(event.target.value)
              }
            />

            <label>Filter by status</label>

            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value)
              }
            >
              <option value="all">All</option>
              <option value="new">New</option>
              <option value="contacted">Contacted</option>
              <option value="qualified">Qualified</option>
              <option value="closed">Closed</option>
            </select>
          </div>

          {!dashboardLoading && leads.length === 0 ? (
            <p>Inga leads ännu.</p>
          ) : filteredLeads.length === 0 ? (
            !dashboardLoading && (
              <p>Inga leads matchar din sökning eller filter.</p>
            )
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Namn</th>
                  <th>Email</th>
                  <th>Tjänst</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredLeads.map((lead) => (
                  <tr key={lead._id}>
                    <td>{lead.name}</td>
                    <td>{lead.email}</td>
                    <td>{lead.service}</td>

                    <td>
                      <select
                        value={lead.status}
                        onChange={(event) =>
                          updateLeadStatus(
                            lead._id,
                            event.target.value
                          )
                        }
                      >
                        <option value="new">New</option>
                        <option value="contacted">
                          Contacted
                        </option>
                        <option value="qualified">
                          Qualified
                        </option>
                        <option value="closed">
                          Closed
                        </option>
                      </select>
                    </td>

                    <td>
                      <button
                        onClick={() => deleteLead(lead._id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
# -family-project
/*
📁 Project Structure Overview:
- /public              → Static files
- /src
  - /components        → Reusable UI components
  - /pages             → Pages like Home, Login, Host
  - /firebase          → Firebase setup and API helpers
  - App.js             → Main app router
  - index.js           → Entry point
- .env                 → Firebase config (you will add this)
- README.md            → Setup instructions
*/

// 📄 src/firebase/config.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 📄 src/App.js
import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import HostDashboard from "./pages/HostDashboard";

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/home" element={<Home />} />
        <Route path="/host" element={<HostDashboard />} />
      </Routes>
    </Router>
  );
}
export default App;

// 📄 src/pages/Login.js
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const [email, setEmail] = useState("");
  const navigate = useNavigate();

  const handleLogin = () => {
    if (email === "1024") {
      navigate("/host");
    } else {
      localStorage.setItem("userEmail", email);
      navigate("/home");
    }
  };

  return (
    <div className="p-4 flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-2xl font-bold mb-4">Welcome</h1>
      <input
        type="text"
        placeholder="Enter email or 1024 for Host"
        className="border p-2 mb-4 w-64"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        className="bg-blue-500 text-white px-4 py-2 rounded"
        onClick={handleLogin}
      >
        Enter
      </button>
    </div>
  );
}

// 📄 src/pages/Home.js
import React from "react";

export default function Home() {
  const userEmail = localStorage.getItem("userEmail");
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold">Hello, {userEmail}</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
        {[...Array(20)].map((_, i) => (
          <div key={i} className="border p-4 text-center bg-gray-100 rounded">
            Content Box {i + 1}
          </div>
        ))}
      </div>
    </div>
  );
}

// 📄 src/pages/HostDashboard.js
import React, { useState } from "react";

export default function HostDashboard() {
  const [mediaBoxes, setMediaBoxes] = useState(Array(20).fill(null));

  const handleAddMedia = (index) => {
    const type = prompt("Type (mp3, mp4, url, ipcam):");
    const link = prompt("Enter link/IP:");
    const updated = [...mediaBoxes];
    updated[index] = { type, link };
    setMediaBoxes(updated);
  };

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold">Host Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
        {mediaBoxes.map((box, i) => (
          <div
            key={i}
            className="border p-4 text-center bg-yellow-100 rounded cursor-pointer"
            onClick={() => handleAddMedia(i)}
          >
            {box ? (
              <div>
                <p>{box.type}</p>
                <a href={box.link} target="_blank" rel="noopener noreferrer">
                  {box.link}
                </a>
              </div>
            ) : (
              `Box ${i + 1} (Click to Add)`
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 📄 src/index.js
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// 📄 public/index.html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Media App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>

// 📄 README.md
# 📱 Media App (Host + User)

## 🛠 Setup
1. **Clone the repo**
```bash
git clone https://github.com/yourusername/media-app.git
cd media-app
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure Firebase**
Create a `.env` file:
```
REACT_APP_FIREBASE_API_KEY=...
REACT_APP_FIREBASE_AUTH_DOMAIN=...
REACT_APP_FIREBASE_PROJECT_ID=...
REACT_APP_FIREBASE_STORAGE_BUCKET=...
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=...
REACT_APP_FIREBASE_APP_ID=...
```

4. **Start the app**
```bash
npm start
```

5. **Deploy** (optional)
You can deploy using Firebase Hosting or GitHub Pages.

---

✅ Now you're ready to go! You can log in with an email or enter `1024` for host access.

---

Let me know when you're ready for the next upgrade: adding email automation, ads, or file uploads!

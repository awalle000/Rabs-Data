import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { BackendConnectionProvider } from './context/BackendConnectionContext.jsx';
import { OrderDraftProvider } from './context/OrderDraftContext.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <BackendConnectionProvider>
        <AuthProvider>
          <OrderDraftProvider>
            <App />
          </OrderDraftProvider>
        </AuthProvider>
      </BackendConnectionProvider>
    </BrowserRouter>
  </StrictMode>
);
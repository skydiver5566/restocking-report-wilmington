// app/root.jsx
import React, { useMemo } from "react";
import polaris from "@shopify/polaris";
import createApp from "@shopify/app-bridge";
import { Outlet } from "react-router-dom";
import "@shopify/polaris/build/esm/styles.css";

// CommonJS destructure
const { AppProvider } = polaris;

// Context to provide App Bridge globally
export const AppBridgeContext = React.createContext(null);

export default function App() {
  const i18n = {
    Polaris: {
      ResourceList: {
        sortingLabel: "Sort by",
        showing: "Showing {itemsCount} results",
      },
      Common: { checkbox: "checkbox" },
    },
  };

  // Create the App Bridge instance only on the client
  const appBridge = useMemo(() => {
    if (typeof window === "undefined") return null; // prevent SSR crash

    const hostParam = new URLSearchParams(window.location.search).get("host");
    if (!hostParam) return null;

    return createApp({
      apiKey: import.meta.env.VITE_SHOPIFY_API_KEY,
      host: hostParam,
      forceRedirect: true,
    });
  }, []);

  return (
    <AppProvider i18n={i18n}>
      <AppBridgeContext.Provider value={appBridge}>
        <Outlet />
      </AppBridgeContext.Provider>
    </AppProvider>
  );
}

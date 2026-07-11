import React, { createContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

export function ThemeProvider({ children, defaultTheme = "system", storageKey = "vite-ui-theme" }) {
    const [theme, setTheme] = useState(() => {
        try {
            return localStorage.getItem(storageKey) || defaultTheme;
        } catch {
            return defaultTheme;
        }
    });

    useEffect(() => {
        const root = window.document.documentElement;

        const applyTheme = () => {
            root.classList.remove("light", "dark");

            if (theme === "system") {
                const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
                    .matches
                    ? "dark"
                    : "light";

                root.classList.add(systemTheme);
                return;
            }

            root.classList.add(theme);
        };

        applyTheme();

        if (theme !== "system") {
            return;
        }

        const media = window.matchMedia("(prefers-color-scheme: dark)");
        media.addEventListener("change", applyTheme);
        return () => {
            media.removeEventListener("change", applyTheme);
        };
    }, [theme]);

    const value = {
        theme,
        setTheme: (theme) => {
            try {
                localStorage.setItem(storageKey, theme);
            } catch {
                // ignore persistence failures
            }
            setTheme(theme);
        },
    };

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export { ThemeContext };

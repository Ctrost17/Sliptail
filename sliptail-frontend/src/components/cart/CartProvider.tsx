"use client";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";


export type CartItem = {
productId: string;
quantity: number;
};


export type CartState = {
items: CartItem[];
};


const CART_KEY = "sliptail.cart";


const loadCart = (): CartState => {
if (typeof window === "undefined") return { items: [] };
try {
const raw = localStorage.getItem(CART_KEY);
return raw ? JSON.parse(raw) : { items: [] };
} catch {
return { items: [] };
}
};


const saveCart = (state: CartState) => {
try {
localStorage.setItem(CART_KEY, JSON.stringify(state));
} catch {}
};


export type CartContextType = {
items: CartItem[];
addItem: (item: CartItem) => Promise<void>;
removeItem: (productId: string) => void;
clear: () => void;
};


const CartContext = createContext<CartContextType | null>(null);


export function CartProvider({ children }: { children: React.ReactNode }) {
const [state, setState] = useState<CartState>({ items: [] });


useEffect(() => {
setState(loadCart());
}, []);


useEffect(() => {
if (typeof window !== "undefined") saveCart(state);
}, [state]);


async function addItem(item: CartItem) {
setState((s) => {
const existingIdx = s.items.findIndex((i) => i.productId === item.productId);
const next = { ...s, items: [...s.items] };
if (existingIdx >= 0) next.items[existingIdx].quantity += item.quantity;
else next.items.push(item);
return next;
});
try {
await api.post("/cart/add", item); // optional backend sync
} catch {}
}


function removeItem(productId: string) {
setState((s) => ({ items: s.items.filter((i) => i.productId !== productId) }));
}


function clear() {
setState({ items: [] });
}


const value = useMemo(() => ({ items: state.items, addItem, removeItem, clear }), [state.items]);


return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}


export function useCart() {
const ctx = useContext(CartContext);
if (!ctx) throw new Error("useCart must be used within <CartProvider>");
return ctx;
}
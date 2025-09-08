export type ProductType = "purchase" | "membership" | "request";


export type Product = {
id: string;
creatorId: string;
title: string;
description?: string;
price: number; // used for all product types (including memberships)
productType: ProductType;
thumbnailUrl?: string;
};


export type Creator = {
id: string;
name: string;
avatarUrl?: string;
};
// Paleta fija de colores de banco. Fuente única: la usan el selector del ABM,
// el CSS de las cards (via data-bank-color) y el Zod de los endpoints.
//
// Son slugs, no hex: el color real vive en page.module.css con un valor propio
// por tema (dark/light), así ningún banco puede quedar ilegible.

export type BankColor = {
  slug: string;
  label: string;
};

export const BANK_COLORS: BankColor[] = [
  { slug: "slate", label: "Gris" },
  { slug: "red", label: "Rojo" },
  { slug: "amber", label: "Ámbar" },
  { slug: "emerald", label: "Verde" },
  { slug: "teal", label: "Turquesa" },
  { slug: "sky", label: "Celeste" },
  { slug: "violet", label: "Violeta" },
  { slug: "rose", label: "Rosa" },
];

export const BANK_COLOR_SLUGS = BANK_COLORS.map((c) => c.slug);

export const DEFAULT_BANK_COLOR = "slate";

export function isBankColor(value: string): boolean {
  return BANK_COLOR_SLUGS.includes(value);
}

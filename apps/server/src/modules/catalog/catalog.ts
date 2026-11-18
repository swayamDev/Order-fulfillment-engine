import type { Tx } from '@sethu/db';

/**
 * The demo catalog: a fictional store, copied into every new sandbox. The
 * console labels it as fictional. Stock levels are fixed so failure paths are
 * reproducible: the brass kettle has only two units, so a third sells out.
 */
export const DEMO_CATALOG = [
  { sku: 'TEA-ASSAM-250', name: 'Assam breakfast tea, 250 g', priceMinor: 42_000, stock: 40 },
  { sku: 'TEA-NILGIRI-100', name: 'Nilgiri frost tea, 100 g', priceMinor: 56_000, stock: 25 },
  { sku: 'MUG-STONE-01', name: 'Stoneware mug, ash glaze', priceMinor: 89_000, stock: 18 },
  { sku: 'POT-CLAY-06', name: 'Clay teapot, six cups', priceMinor: 245_000, stock: 6 },
  { sku: 'KETTLE-BRASS', name: 'Hammered brass kettle', priceMinor: 640_000, stock: 2 },
  { sku: 'STRAINER-STEEL', name: 'Steel tea strainer', priceMinor: 18_000, stock: 60 },
] as const;

export async function seedDemoCatalog(tx: Tx, sandboxId: string): Promise<void> {
  await tx
    .insertInto('products')
    .values(
      DEMO_CATALOG.map((p) => ({
        sandbox_id: sandboxId,
        sku: p.sku,
        name: p.name,
        price_minor: p.priceMinor,
      })),
    )
    .execute();
  await tx
    .insertInto('stock')
    .values(DEMO_CATALOG.map((p) => ({ sandbox_id: sandboxId, sku: p.sku, available: p.stock })))
    .execute();
}

// SPDX-License-Identifier: GPL-3.0-or-later
/** Product credit written into exported STEP / STL metadata. */
export interface Brand {
  product: string;
  line: string;
}

/** OpenFinShaper's credit, written into fin exports. */
export const FIN_BRAND: Brand = {
  product: 'OpenFinShaper',
  line: 'Made with OpenFinShaper · openfinshaper.com',
};

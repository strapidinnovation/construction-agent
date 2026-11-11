"""Print nearby comparable homes from Realtor.com as JSON ("comps").

Usage: realtor_comps.py <address> <sold|rent> <radius_miles>

  sold - single-family homes and townhomes sold in the last 12 months.
  rent - single-family homes and townhomes currently listed for rent.

Texas does not require sale prices to be disclosed, so sold homes usually
have no sale price; their last asking price is returned instead, and the
"priceKind" field says which one it is. For rentals, the price is the
monthly rent. Filtering by size and working out medians happens in
TypeScript (src/agents/feasibility.ts).
"""

import json
import math
import sys

from homeharvest import scrape_property


def clean(value):
    """Turn pandas' missing values (NaN, NA) into None so they become JSON null."""
    try:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        if str(value) in ("<NA>", "NaT", "nan"):
            return None
    except (TypeError, ValueError):
        return None
    return value


def main():
    address, mode, radius = sys.argv[1], sys.argv[2], float(sys.argv[3])
    df = scrape_property(
        location=address,
        listing_type="sold" if mode == "sold" else "for_rent",
        radius=radius,
        property_type=["single_family", "townhomes"],
        past_days=365 if mode == "sold" else None,
        limit=300,
        extra_property_data=False,
    )

    comps = []
    for row in df.to_dict(orient="records"):
        sold = clean(row.get("sold_price"))
        asking = clean(row.get("list_price"))
        price = sold if sold else asking
        sqft = clean(row.get("sqft"))
        if not price or not sqft:
            continue
        comps.append(
            {
                "address": clean(row.get("formatted_address")),
                "price": price,
                "priceKind": "rent" if mode == "rent" else ("sold" if sold else "asking"),
                "sqft": sqft,
                "beds": clean(row.get("beds")),
                "yearBuilt": clean(row.get("year_built")),
                "date": str(clean(row.get("last_sold_date") if mode == "sold" else row.get("list_date")) or "")[:10],
                "url": clean(row.get("property_url")),
            }
        )
    json.dump(comps, sys.stdout, default=to_json_number)


def to_json_number(value):
    if hasattr(value, "is_integer") and not value.is_integer():
        return float(value)
    if hasattr(value, "__int__"):
        return int(value)
    return str(value)


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(f"{type(err).__name__}: {err}", file=sys.stderr)
        sys.exit(1)

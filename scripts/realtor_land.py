"""Print for-sale land listings from Realtor.com as JSON.

Usage: realtor_land.py <location> <min_price> <max_price>
"""

import json
import math
import sys

from homeharvest import scrape_property


def clean(value):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return value


def main():
    location, min_price, max_price = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])

    df = scrape_property(
        location=location,
        listing_type="for_sale",
        property_type=["land"],
        price_min=min_price or None,
        price_max=max_price,
        limit=500,
        extra_property_data=False,
    )

    listings = [
        {
            "address": clean(row.get("formatted_address")),
            "city": clean(row.get("city")),
            "state": clean(row.get("state")),
            "zipCode": clean(row.get("zip_code")),
            "county": clean(row.get("county")),
            "latitude": clean(row.get("latitude")),
            "longitude": clean(row.get("longitude")),
            "priceUsd": clean(row.get("list_price")),
            "lotSqft": clean(row.get("lot_sqft")),
            "url": clean(row.get("property_url")),
        }
        for row in df.to_dict(orient="records")
    ]
    json.dump(listings, sys.stdout, default=to_json_number)


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

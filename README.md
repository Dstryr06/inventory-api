# Inventory System API

A simple Node.js and Express inventory system that retrieves product catalog data from DummyJSON and stores local stock quantities and transactions in JSON files.

## Run
```bash
npm install
npm start
```
Open `http://localhost:3000`. Click **Sync Products** before making the first stock adjustment.

## API Routes
- `GET /api/health`
- `POST /api/inventory/sync`
- `GET /api/inventory`
- `GET /api/inventory/:id`
- `PATCH /api/inventory/:id`
- `POST /api/inventory/:id/adjust`
- `GET /api/transactions`
- `GET /api/reports/summary`

## Design
DummyJSON supplies product names, prices, categories, SKUs, and images. Local JSON files persist inventory quantities, reorder levels, and transaction history. DummyJSON is intended for testing and prototyping, not production commerce data.

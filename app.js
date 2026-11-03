//create post, edit, deelete

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PRODUCT_API = "https://dummyjson.com/products";
const INVENTORY_FILE = path.join(__dirname, "data", "inventory.json");
const TRANSACTION_FILE = path.join(__dirname, "data", "transactions.json");
const CATEGORY_FILE = path.join(__dirname, "data", "category.json");

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function httpError(status, message, errors) {
  const error = new Error(message); error.status = status; error.errors = errors; return error;
}
function readJson(file) {
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(value)) throw new Error("File must contain an array."); return value; }
  catch (error) { throw httpError(500, `Unable to read ${path.basename(file)}.`, [error.message]); }
}

function writeJson(file, data) {
  try { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(data, null, 2)); fs.renameSync(temp, file); }
  catch (error) { throw httpError(500, `Unable to save ${path.basename(file)}.`, [error.message]); }
}


async function getRemoteProducts(limit = 30) {
  let response;
  try { response = await fetch(`${PRODUCT_API}?limit=${limit}&select=id,title,description,category,price,brand,sku,thumbnail,stock`); }
  catch { throw httpError(502, "Cannot connect to the online product service."); }
  if (!response.ok) throw httpError(502, `Product service returned HTTP ${response.status}.`);
  const result = await response.json(); return result.products || [];
}

function positiveId(value) { const id=Number(value); if(!Number.isInteger(id)||id<1) throw httpError(400,"Product ID must be a positive integer."); return id; }
function inventoryMap() { return new Map(readJson(INVENTORY_FILE).map(item => [item.productId,item])); }


//changes in the program will be saved or live inside the program

//products added would not clash with DummyJSON ids
const FIRST_CUSTOM_ID = 1001;

function stockStatus(inv) {
  return inv.quantity === 0 ? "Out of Stock" : inv.quantity <= inv.reorderLevel ? "Low Stock" : "In Stock"; 
}

//ignoring upper/lower cases, dashes and words ending in "s"
function catKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
}

//showing products created or added

function customView(item, categories) {
  const cat = categories.find( c=> c.catId === item.catId);
  return {
    id: item.productId, title: item.title, description: item.description || "", category: cat ? cat.catName : "Uncategorized", catId: item.catId, price: item.price, brand: item.brand || "", thumbnail: item.thumbnail || "", quantity: item.quantity, reorderLevel: item.reorderLevel, status: stockStatus(item), custom: true
  };
}

//merging DummyJSON, updated/deleted/added products
function buildProducts(remoteProducts){
  const local = inventoryMap();
  const categories = readJson(CATEGORY_FILE);
  const online = remoteProducts.filter(p => !local.get(p.id)?.deleted).map(p => {
    const inv = local.get(p.id) || { quantity: p.stock ?? 0, reorderLevel: 10 };
    const cat = categories.find(c => catKey(c.catName) === catKey(p.category));
    return {
      ...p, title: inv.title ?? p.title, description: inv.description ?? p.description, catId: cat ? cat.catId : null, quantity: inv.quantity, reorderLevel: inv.reorderLevel, status: stockStatus(inv), custom: false
    };
  });
  const own =[...local.values()].filter(i => i.custom).map(i => customView(i, categories));
  return [...online, ...own];
}

async function getRemoteProduct(id){
  let response;
  try { 
    response = await fetch(`${PRODUCT_API}/${id}`);
  }
  catch {
    throw httpError(502, "Cannot connect to the online product service.");
  }
  if (response.status === 404) throw httpError(404, "Product not found.");
  if (!response.ok) throw httpError(502, `Product service returned HTTP ${response.status}.`);
  return response.json();
}

function validateProduct(req, res, next) {
  const b = req.body || {}; const isNew = req.method ==="POST";
  const errors = [];
  const has = key => b[key] !== undefined;
  const blank = value => value ==="" || value === null;

  if (isNew || has("title")) {
    const title = String(b.title ?? "").trim();
    if (!title) errors.push("Title is required.");
    else if (title.length > 100) errors.push("Title must be 100 characters or less.");
  }
  if (has("description") && String(b.description).length > 1000) errors.push("Description must be 1000 characters or less.");
  if (isNew || has("price")) {
    const price = Number(b.price);
    if (b.price === undefined || blank(b.price) || !Number.isFinite(price) || price < 0) errors.push("Price must be a number that is 0 or more.");
  }
  if (isNew || has("catId")) {
    if (!readJson(CATEGORY_FILE).some(c => c.catId === Number(b.catId))) errors.push("Choose a category that exists.");
  }
  if (isNew && has("quantity") && !blank(b.quantity)) {
    const q = Number(b.quantity); if (!Number.isInteger(q) || q < 0) errors.push("Quantity must be a non-negative integer.");
  }
  if (has("thumbnail") && !blank(b.thumbnail) && !/^https?:\/\//i.test(String(b.thumbnail).trim())) errors.push("Thumbnail must be a link starting with http:// or https://.");
  if (errors.length) return next(httpError(400, "Validation failed.", errors));
  next();
}

function validateCategory(req, res, next) {
  const b =req.body || {}; const isNew = req.method ==="POST";
  const errors = [];
  if (isNew || b.catName !== undefined){
    const name = String(b.catName ?? "").trim(); const selfId = Number(req.params.id);
    if (!name) errors.push("Category name is required.");
    else if (name.length > 50) errors.push("Category name must be 50 characters or less.");
    else if (readJson(CATEGORY_FILE).some(c => c.catName.toLowerCase() === name.toLowerCase() && c.catId !== selfId)) errors.push("That category name already exists.");
  }
  if (b.catDescription !== undefined && String(b.catDescription).length > 200) errors.push ("Description must be 200 characters or less.");
  if (errors.length) return next (httpError(400, "Validation failed.", errors));
  next();
}


//
app.get("/api/health", (req,res)=>res.json({success:true,message:"Inventory API is running."}));
app.post("/api/inventory/sync", async (req,res,next)=>{try{
  const products=await getRemoteProducts(30); const current=inventoryMap();
  for(const p of products) if(!current.has(p.id)) current.set(p.id,{productId:p.id,quantity:p.stock??0,reorderLevel:10,updatedAt:new Date().toISOString()});
  const data=[...current.values()].sort((a,b)=>a.productId-b.productId); writeJson(INVENTORY_FILE,data);
  res.json({success:true,message:"Product catalog synchronized.",count:data.length});
}catch(e){next(e)}});

//
app.get("/api/inventory", async (req,res,next)=>{try{
  const search=String(req.query.search||"").trim().toLowerCase(); const products=await getRemoteProducts(30); 
  let data = buildProducts(products);
  if(search) data=data.filter(p => [p.title, p.category, p.brand|| "", p.sku||""].some(v => String(v).toLowerCase().includes(search)));
  res.json({success:true,count:data.length,data});
}catch(e){next(e)}});

//get item based on id
app.get("/api/inventory/:id", async (req,res,next)=>{try{
  const id = positiveId(req.params.id);
  const saved = inventoryMap().get(id);
  if(saved?.deleted) throw httpError(404, "Product not found.");
  if(saved?.custom) return res.json({
    success:true,
    data:customView(saved, readJson(CATEGORY_FILE))
  });

  const response=await fetch(`${PRODUCT_API}/${id}`); if(!response.ok) throw httpError(404,"Product not found.");
  
  const p=await response.json(); const inv=saved||{quantity:p.stock??0,reorderLevel:10};

  res.json({success:true,data:{...p,title:inv.title??p.title,description:inv.description??p.description,quantity:inv.quantity,reorderLevel:inv.reorderLevel}});

}catch(e){next(e)}});

//editing
app.patch("/api/inventory/:id", (req,res,next)=>{try{
  const id=positiveId(req.params.id); const quantity=Number(req.body.quantity); const reorderLevel=Number(req.body.reorderLevel);

  const errors=[]; if(!Number.isInteger(quantity)||quantity<0) errors.push("Quantity must be a non-negative integer."); if(!Number.isInteger(reorderLevel)||reorderLevel<0) errors.push("Reorder level must be a non-negative integer."); if(errors.length) throw httpError(400,"Validation failed.",errors);

  const items=readJson(INVENTORY_FILE); const index=items.findIndex(x=>x.productId===id); const record={...(items[index]||{}),productId:id,quantity,reorderLevel,updatedAt:new Date().toISOString()}; //changed to keep title,description, ect. instead of wiping them

  if(index===-1) items.push(record); else items[index]=record; writeJson(INVENTORY_FILE,items);

  res.json({success:true,message:"Inventory updated successfully.",data:record});
}catch(e){next(e)}});

//post update inventory
app.post("/api/inventory/:id/adjust", (req,res,next)=>{try{
  const id=positiveId(req.params.id); const change=Number(req.body.change); const note=String(req.body.note||"").trim();
  if(!Number.isInteger(change)||change===0) throw httpError(400,"Change must be a non-zero integer.");
  const items=readJson(INVENTORY_FILE); const index=items.findIndex(x=>x.productId===id); if(index===-1) throw httpError(404,"Synchronize the inventory before adjusting stock.");
  const nextQuantity=items[index].quantity+change; if(nextQuantity<0) throw httpError(400,"Stock cannot become negative.");
  items[index].quantity=nextQuantity; items[index].updatedAt=new Date().toISOString(); writeJson(INVENTORY_FILE,items);
  const transactions=readJson(TRANSACTION_FILE); const transaction={id:Date.now(),productId:id,change,note,quantityAfter:nextQuantity,createdAt:new Date().toISOString()}; transactions.unshift(transaction); writeJson(TRANSACTION_FILE,transactions);
  res.json({success:true,message:"Stock adjusted successfully.",data:transaction});
}catch(e){next(e)}});




//add create (post) (edit) (delete)


//POST NEW PRODUCT
app.post("/api/inventory/additem/", validateProduct, (req, res, next) => {try{
  const b = req.body;
    const items = readJson(INVENTORY_FILE);
    const usedIds = [...items.map(i => i.productId), ...readJson(TRANSACTION_FILE).map(t => t.productId)];

    const newProduct = {
      productId: Math.max(FIRST_CUSTOM_ID - 1, ...usedIds) + 1,
      custom: true,
      title: String(b.title).trim(),
      description: String(b.description || "").trim(),
      catId: Number(b.catId),
      price: Number(b.price),
      brand: String(b.brand || "").trim(),
      thumbnail: String(b.thumbnail || "").trim(),
      quantity: b.quantity === undefined || b.quantity === "" ? 0 : Number(b.quantity),
      reorderLevel: 10,
      updatedAt: new Date().toISOString()
    };

    items.push(newProduct);
    writeJson(INVENTORY_FILE, items);

    res.status(201).json({
        success: true,
        message: "Product added successfully",
        data: customView( newProduct, readJson(CATEGORY_FILE))
    });

}catch(e){next(e)}
});

//EDIT name,description
app.put("/api/inventory/:id/update", validateProduct, async (req, res, next) => {try{
    const id = positiveId(req.params.id);
    const items = readJson(INVENTORY_FILE);
    const index = items.findIndex(x => x.productId === id);
    const existing = index === -1 ? null : items[index];
    
    if (existing?.deleted) throw httpError(404, "Product not found!");

    // products from DummyJSON: only name + description. products we created: everything except stock
    const allowed = existing?.custom
        ? ["title", "description", "price", "brand", "thumbnail", "catId"]
        : ["title", "description"];
    const sent = Object.keys(req.body);
    if (sent.length === 0) throw httpError(400, "Nothing to update.");
    const notAllowed = sent.filter(k => !allowed.includes(k));
    if (notAllowed.length) throw httpError(400, "Validation failed.", [
        `Cannot edit: ${notAllowed.join(", ")}. Allowed: ${allowed.join(", ")}. (Quantity and reorder level use PATCH /api/inventory/:id.)`
    ]);

    let record = existing;
    if (!record) {
        const p = await getRemoteProduct(id); // makes sure the product really exists online
        record = { productId: id, quantity: p.stock ?? 0, reorderLevel: 10 };
    }
    for (const key of sent) record[key] = typeof req.body[key] === "string" ? req.body[key].trim() : req.body[key];
    if ("price" in req.body) record.price = Number(req.body.price);
    if ("catId" in req.body) record.catId = Number(req.body.catId);
    record.updatedAt = new Date().toISOString();

    if (index === -1) items.push(record); else items[index] = record;
    writeJson(INVENTORY_FILE, items);

    res.json({
        success: true,
        message: "Product updated successfully!",
        data: record
    });
}catch(e){next(e)}
});

//DELETE
app.delete("/api/inventory/:id", async (req, res, next) => {try{
    const id = positiveId(req.params.id);
    const items = readJson(INVENTORY_FILE);
    const index = items.findIndex(x => x.productId === id);
    const existing = index === -1 ? null : items[index];

    if (existing?.deleted) throw httpError(404, "Product not found!");

    // our own product: really remove it
    if (existing?.custom) {
        items.splice(index, 1);
        writeJson(INVENTORY_FILE, items);
        return res.status(200).json({
            success: true,
            message: "Product deleted successfully",
            deletedProduct: existing
        });
    }

    // DummyJSON product: we can't delete it online, so we mark it as deleted and hide it
    const p = await getRemoteProduct(id);
    const record = {
        ...(existing || { productId: id, quantity: p.stock ?? 0, reorderLevel: 10 }),
        deleted: true,
        updatedAt: new Date().toISOString()
    };
    if (index === -1) items.push(record); else items[index] = record;
    writeJson(INVENTORY_FILE, items);

    res.status(200).json({
        success: true,
        message: "Product removed from the inventory",
        deletedProduct: record
    });

}catch(e){next(e)}
});

//seperate page for encoding of new category
//Category must perform CRUD operation 

function categoryId(value) { const id = Number(value); if (!Number.isInteger(id) || id < 1) throw httpError(400, "Category ID must be a positive integer."); return id; }

//READ
app.get("/api/categories", (req, res, next) => {try{
    const data = readJson(CATEGORY_FILE);
    res.json({ success: true, count: data.length, data });
}catch(e){next(e)}});

//CREATE
app.post("/api/categories", validateCategory, (req, res, next) => {try{
    const categories = readJson(CATEGORY_FILE);
    const newCategory = {
        catId: categories.length > 0 ? Math.max(...categories.map(c => c.catId)) + 1 : 1,
        catName: String(req.body.catName).trim(),
        catDescription: String(req.body.catDescription || "").trim()
    };
    categories.push(newCategory);
    writeJson(CATEGORY_FILE, categories);
    res.status(201).json({ success: true, message: "Category added successfully.", data: newCategory });
}catch(e){next(e)}});

//UPDATE
app.put("/api/categories/:id", validateCategory, (req, res, next) => {try{
    const id = categoryId(req.params.id);
    const categories = readJson(CATEGORY_FILE);
    const index = categories.findIndex(c => c.catId === id);
    if (index === -1) throw httpError(404, "Category not found!");
    if (req.body.catName === undefined && req.body.catDescription === undefined) throw httpError(400, "Nothing to update.");

    if (req.body.catName !== undefined) categories[index].catName = String(req.body.catName).trim();
    if (req.body.catDescription !== undefined) categories[index].catDescription = String(req.body.catDescription).trim();
    writeJson(CATEGORY_FILE, categories);
    res.json({ success: true, message: "Category updated successfully!", data: categories[index] });
}catch(e){next(e)}});

//DELETE
app.delete("/api/categories/:id", async (req, res, next) => {try{
    const id = categoryId(req.params.id);
    const categories = readJson(CATEGORY_FILE);
    const category = categories.find(c => c.catId === id);
    if (!category) throw httpError(404, "Category not found!");

    const inUse = buildProducts(await getRemoteProducts(30)).filter(p => p.catId === id).length;
    if (inUse > 0) throw httpError(409, `Cannot delete "${category.catName}": ${inUse} product(s) still use it.`);

    writeJson(CATEGORY_FILE, categories.filter(c => c.catId !== id));
    res.json({ success: true, message: "Category deleted successfully", deletedCategory: category });
}catch(e){next(e)}
});

app.get("/api/transactions",(req,res,next)=>{try{const data=readJson(TRANSACTION_FILE);res.json({success:true,count:data.length,data});}catch(e){next(e)}});

//counts the buildProducts so deleted products are skipped, and added products are included
app.get("/api/reports/summary",async(req,res,next)=>{try{const products=await getRemoteProducts(30);const rows=buildProducts(products);res.json({success:true,data:{products:rows.length,totalUnits:rows.reduce((s,p)=>s+p.quantity,0),inventoryValue:rows.reduce((s,p)=>s+p.quantity*p.price,0),lowStock:rows.filter(p=>p.quantity>0&&p.quantity<=p.reorderLevel).length,outOfStock:rows.filter(p=>p.quantity===0).length}})}catch(e){next(e)}});

app.use((req,res,next)=>next(httpError(404,`Route ${req.method} ${req.originalUrl} was not found.`)));

app.use((err,req,res,next)=>{console.error(err);res.status(err.status||500).json({success:false,message:err.message||"Internal Server Error",...(err.errors?{errors:err.errors}:{})})});

app.listen(PORT,"0.0.0.0",()=>console.log(`Inventory System running at http://localhost:${PORT}`));
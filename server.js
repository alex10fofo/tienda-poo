const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tiendapoo',
    port: process.env.DB_PORT || 3306
});

db.connect(err => { 
    if(err) {
        console.error("❌ Error conectando a MySQL:", err);
        throw err;
    }
    console.log("✅ Servidor Vinculado a MySQL (Aiven)");

    // ESTO CREARÁ TUS TABLAS AUTOMÁTICAMENTE
    const queries = [
        `CREATE TABLE IF NOT EXISTS proveedores (NIF VARCHAR(50) PRIMARY KEY, NOMBRE VARCHAR(100), DIRECCION VARCHAR(255))`,
        `CREATE TABLE IF NOT EXISTS productos (CODIGO INT PRIMARY KEY, NOMBRE VARCHAR(100), PRECIO DECIMAL(10,2), NIF VARCHAR(50), stock INT, FOREIGN KEY (NIF) REFERENCES proveedores(NIF))`,
        `CREATE TABLE IF NOT EXISTS clientes (COD_CLIENTE INT PRIMARY KEY, NOMBRE VARCHAR(100), APELLIDO VARCHAR(100), RFC VARCHAR(15), DIRECCION VARCHAR(255), FCA_NAC DATE, password VARCHAR(50), avatar TEXT)`,
        `CREATE TABLE IF NOT EXISTS productos_clientes (id INT AUTO_INCREMENT PRIMARY KEY, CODIGO INT, COD_CLIENTE INT, id_ticket VARCHAR(50), fecha_compra TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (CODIGO) REFERENCES productos(CODIGO), FOREIGN KEY (COD_CLIENTE) REFERENCES clientes(COD_CLIENTE))`
    ];

    queries.forEach(q => {
        db.query(q, (err) => { if(err) console.log("Info: Tabla ya lista."); });
    });
});

// --- PRODUCTOS ---
app.get('/api/productos', (req, res) => {
    db.query('SELECT * FROM productos', (err, results) => res.json(results));
});

// --- API PROVEEDORES ---
app.get('/api/proveedores', (req, res) => {
    db.query('SELECT * FROM proveedores', (err, results) => res.json(results));
});

// --- API NUEVO PROVEEDOR ---
app.post('/api/nuevo-proveedor', (req, res) => {
    const { nif, nombre, direccion } = req.body;
    const sql = 'INSERT INTO proveedores (NIF, NOMBRE, DIRECCION) VALUES (?, ?, ?)';
    db.query(sql, [nif, nombre, direccion], (err) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).send("OK");
    });
});

// --- LOGIN (Manda el avatar a la tienda) ---
app.post('/login', (req, res) => {
    const { id_cliente, password } = req.body;
    db.query('SELECT * FROM clientes WHERE COD_CLIENTE = ? AND password = ?', [parseInt(id_cliente), password], (err, results) => {
        if (results && results.length > 0) {
            const c = results[0];
            res.redirect(`/cliente.html?id=${c.COD_CLIENTE}&nombre=${c.NOMBRE}&img=${encodeURIComponent(c.avatar)}`);
        } else {
            res.send(`<script>alert("❌ Datos incorrectos"); window.location.href="/login.html";</script>`);
        }
    });
});

// --- REGISTRO ---
app.post('/registro-cliente', (req, res) => {
    const { cod, nom, ape, rfc, dir, fca, pass, avatar } = req.body;
    const sql = `INSERT INTO clientes (COD_CLIENTE, NOMBRE, APELLIDO, RFC, DIRECCION, FCA_NAC, password, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.query(sql, [cod, nom, ape, rfc, dir, fca, pass, avatar], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/login.html');
    });
});

// --- COMPRA ---
app.post('/finalizar-compra', (req, res) => {
    const { id_cliente, items } = req.body; 
    const idTicket = 'TICK-' + Date.now(); // Esto genera el número de ticket
    
    // Usamos una promesa para saber cuando todos los productos se inserten
    const promesas = items.map(item => {
        return new Promise((resolve, reject) => {
            // INSERTAR EN LA TABLA DE VENTAS
            const sqlInsert = 'INSERT INTO productos_clientes (CODIGO, COD_CLIENTE, id_ticket) VALUES (?, ?, ?)';
            db.query(sqlInsert, [item.codigo, id_cliente, idTicket], (err) => {
                if (err) return reject(err);
                
                // ACTUALIZAR EL STOCK (Restar lo que se compró)
                const sqlUpdate = 'UPDATE productos SET stock = stock - ? WHERE CODIGO = ?';
                db.query(sqlUpdate, [item.cantidad, item.codigo], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    });

    Promise.all(promesas)
        .then(() => {
            res.json({ success: true, ticket: idTicket });
        })
        .catch(err => {
            console.error("Error en la compra:", err);
            res.status(500).json({ success: false, error: err.message });
        });
});

// --- HISTORIAL ---
app.get('/api/historial', (req, res) => {
    const sql = `SELECT id_ticket, fecha_compra, SUM(p.PRECIO) as total FROM productos_clientes pc JOIN productos p ON pc.CODIGO = p.CODIGO GROUP BY id_ticket ORDER BY fecha_compra DESC`;
    db.query(sql, (err, results) => res.json(results));
});

// --- TICKET DETALLE ---
app.get('/api/ticket/:id', (req, res) => {
    const sql = `
        SELECT 
            p.NOMBRE AS producto, 
            p.PRECIO AS precio, 
            c.NOMBRE AS cliente, 
            c.APELLIDO AS apellido
        FROM productos_clientes pc
        JOIN productos p ON pc.CODIGO = p.CODIGO
        JOIN clientes c ON pc.COD_CLIENTE = c.COD_CLIENTE
        WHERE pc.id_ticket = ?`;
    
    db.query(sql, [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// --- RUTA PARA SURTIR STOCK (FALTABA ESTA) ---
app.post('/surtir', (req, res) => {
    const { cod, cant } = req.body; 
    
    // Convertimos a números para evitar errores
    const codigoProd = parseInt(cod);
    const cantidadASumar = parseInt(cant);

    const sql = 'UPDATE productos SET stock = stock + ? WHERE CODIGO = ?';
    
    db.query(sql, [cantidadASumar, codigoProd], (err, result) => {
        if (err) {
            console.error("Error al surtir:", err);
            return res.status(500).send("Error en la base de datos");
        }
        
        // Si todo sale bien, regresamos al panel de proveedor
        res.send(`
            <script>
                alert("✅ Stock actualizado correctamente");
                window.location.href = "/proveedor.html";
            </script>
        `);
    });
});

// --- ESTA ES LA RUTA QUE TE FALTA EN SERVER.JS ---
app.post('/nuevo-prod', (req, res) => {
    const { cod, nom, pre, nif, stk } = req.body;
    
    // El SQL debe coincidir con tus columnas de la base de datos
    const sql = `INSERT INTO productos (CODIGO, NOMBRE, PRECIO, NIF, stock) VALUES (?, ?, ?, ?, ?)`;
    
    db.query(sql, [cod, nom, pre, nif, stk], (err, result) => {
        if (err) {
            console.error("Error al insertar producto:", err);
            return res.status(500).send("Error al guardar en la base de datos: " + err.message);
        }
        res.status(200).send("OK");
    });
});

// --- RUTA PARA AÑADIR (POST) ---
app.post('/api/add-proveedor', (req, res) => {
    const { nif, nombre, direccion } = req.body;
    const sql = 'INSERT INTO proveedores (NIF, NOMBRE, DIRECCION) VALUES (?, ?, ?)';
    db.query(sql, [nif, nombre, direccion], (err) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).send("OK");
    });
});

// --- RUTA PARA ACTUALIZAR (POST) ---
app.post('/api/update-proveedor', (req, res) => {
    const { nif, nombre, direccion } = req.body;
    const sql = 'UPDATE proveedores SET NOMBRE = ?, DIRECCION = ? WHERE NIF = ?';
    db.query(sql, [nombre, direccion, nif], (err) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).send("OK");
    });
});

// --- RUTA PARA ELIMINAR (DELETE) ---
app.delete('/api/delete-proveedor/:nif', (req, res) => {
    const nif = req.params.nif;
    db.query('DELETE FROM proveedores WHERE NIF = ?', [nif], (err) => {
        if (err) {
            // Si el error es por llaves foráneas (tiene productos)
            return res.status(400).send("No se puede eliminar");
        }
        res.status(200).send("OK");
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
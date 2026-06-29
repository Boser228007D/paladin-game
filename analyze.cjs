const fs = require('fs');

try {
    const data = fs.readFileSync('public/assets/Map/scene.gltf', 'utf8');
    const gltf = JSON.parse(data);
    
    console.log("Meshes count:", gltf.meshes ? gltf.meshes.length : 0);
    console.log("Nodes count:", gltf.nodes ? gltf.nodes.length : 0);
    console.log("Materials count:", gltf.materials ? gltf.materials.length : 0);
    
} catch (e) {
    console.error("Error reading GLTF:", e);
}

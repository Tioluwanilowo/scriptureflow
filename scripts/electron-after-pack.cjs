const fs = require('fs');
const path = require('path');

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    console.log(`[afterPack] not found (skip): ${targetPath}`);
    return;
  }

  fs.unlinkSync(targetPath);
  console.log(`[afterPack] removed stale DLL: ${targetPath}`);
}

module.exports = async function afterPack(context) {
  const grandioseRoot = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'grandiose',
  );

  const staleDllPaths = [
    path.join(grandioseRoot, 'build', 'Release', 'Processing.NDI.Lib.x64.dll'),
    path.join(grandioseRoot, 'lib', 'win_x64', 'Processing.NDI.Lib.x64.dll'),
  ];

  staleDllPaths.forEach(removeIfExists);
};


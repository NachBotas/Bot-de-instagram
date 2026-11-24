#!/bin/bash
# Doble clic en Mac para abrir el setter.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Necesitás instalar Node.js primero: https://nodejs.org (la versión LTS)"
  read -r -p "Apretá Enter para cerrar"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Instalando por primera vez, puede tardar un par de minutos..."
  npm install
fi
echo
echo "Abriendo el panel del setter. NO cierres esta ventana mientras quieras que el bot responda."
echo
npm run app

function buscarYRedirigir() {
  const overlay = document.getElementById('overlay-index');
  const cedulaInput = document.getElementById('cedula');
  const cedula = (cedulaInput?.value || '').trim();

  if (!/^\d{10}$/.test(cedula)) {
    alert('Por favor ingrese una cedula valida de 10 digitos');
    return;
  }

  if (overlay) overlay.style.display = 'flex';
  window.location.href = `reporte.html?cedula=${cedula}`;
}

window.addEventListener('DOMContentLoaded', () => {
  const cedulaInput = document.getElementById('cedula');
  const btnBuscar = document.getElementById('btn-buscar-index');

  if (btnBuscar) {
    btnBuscar.addEventListener('click', buscarYRedirigir);
  }

  if (cedulaInput) {
    cedulaInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') buscarYRedirigir();
    });
  }
});
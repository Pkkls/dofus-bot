// node --test heal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHeal } from './heal.mjs';

test('finds a renamed progression button', () => {
  assert.equal(pickHeal('Fin du tour', ['Passer', 'Fin de tour', 'Fuir'])?.label, 'Fin de tour');
  assert.equal(pickHeal('Étape suivante', ['Etape suivante !', 'Retour'])?.label, 'Etape suivante !');
});

test('never heals into a button with consequences', () => {
  assert.equal(pickHeal('Auto', ['Auto AFK (gains −50 %)']), null);
  assert.equal(pickHeal('Suivant en auto', ['Vendre en auto', 'Fuir en auto']), null);
});

test('returns null when nothing is close enough', () => {
  assert.equal(pickHeal('Attaquer', ['Inventaire', 'Deck', 'Chasse']), null);
});

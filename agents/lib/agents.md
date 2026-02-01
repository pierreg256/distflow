# Règles spécifiques - Développement de la lib

## Objectif
Définir les règles pour la création de la librairie TypeScript.

## Principes
- API simple, stable et documentée.
- Démarrage automatique du PMD et gestion transparente.
- Un seul nœud par process.

## Structure
- Source dans packages/core.
- Exposer uniquement les APIs publiques.

## Tests
- Tests unitaires sur la mailbox et le routage.
- Tests d’intégration sur l’enregistrement PMD.

## Documentation
- Chaque export public doit être documenté.
# Contributing to distflow

Merci de votre intérêt pour contribuer à distflow!

## Code de conduite

- Soyez respectueux et professionnel
- Accueillez les nouvelles idées et perspectives
- Concentrez-vous sur ce qui est le mieux pour la communauté
- Faites preuve d'empathie envers les autres membres

## Comment contribuer

### Signaler des bugs

Si vous trouvez un bug:

1. Vérifiez qu'il n'a pas déjà été signalé dans les issues
2. Créez une nouvelle issue avec:
   - Description claire du problème
   - Steps to reproduce
   - Comportement attendu vs comportement observé
   - Version de Node.js et npm
   - Environnement (OS, etc.)

### Proposer des fonctionnalités

Pour proposer une nouvelle fonctionnalité:

1. Ouvrez une issue pour en discuter d'abord
2. Expliquez le cas d'usage
3. Proposez une implémentation si possible
4. Attendez le feedback avant de commencer le code

### Contribuer du code

#### Setup

```bash
# Fork le projet
git clone https://github.com/VOTRE-USERNAME/distflow.git
cd distflow

# Installer les dépendances
npm install

# Builder le projet
npm run build

# Lancer les tests
npm test
```

#### Workflow

1. **Créer une branche**
   ```bash
   git checkout -b feature/ma-fonctionnalite
   ```

2. **Faire vos modifications**
   - Suivez les règles de codage (voir ci-dessous)
   - Ajoutez des tests si nécessaire
   - Mettez à jour la documentation

3. **Tester**
   ```bash
   npm run build
   npm test
   ```

4. **Commiter**
   ```bash
   git add .
   git commit -m "feat: description courte de la fonctionnalité"
   ```

5. **Pusher et créer une PR**
   ```bash
   git push origin feature/ma-fonctionnalite
   ```
   Puis créez une Pull Request sur GitHub

## Règles de codage

Suivez les règles définies dans `agents/general/agents.md`:

### TypeScript

- ✅ Mode strict activé
- ✅ Types explicites pour les APIs publiques
- ✅ Éviter `any` (utiliser `unknown` si nécessaire)
- ✅ Préférer `const` et `let` (jamais `var`)
- ✅ Fonctions pures quand possible

### Nommage

- ✅ camelCase pour variables et fonctions
- ✅ PascalCase pour classes et interfaces
- ✅ UPPER_CASE pour constantes
- ✅ Noms descriptifs et clairs

### Documentation

- ✅ JSDoc pour toutes les APIs publiques
- ✅ Commentaires pour la logique complexe
- ✅ README à jour
- ✅ Exemples de code si nécessaire

### Tests

- ✅ Tests unitaires pour la logique métier
- ✅ Tests d'intégration pour les flux critiques
- ✅ Tests déterministes et isolés
- ✅ Pas de dépendances entre tests

## Structure des commits

Utilisez le format conventional commits:

- `feat:` - Nouvelle fonctionnalité
- `fix:` - Correction de bug
- `docs:` - Documentation seulement
- `style:` - Formatage, point-virgules, etc.
- `refactor:` - Refactoring sans changement de comportement
- `test:` - Ajout ou modification de tests
- `chore:` - Maintenance, dépendances, etc.

Exemples:
```
feat: add support for custom PMD port
fix: resolve memory leak in transport layer
docs: update QUICKSTART with examples
```

## Architecture du projet

Avant de contribuer, familiarisez-vous avec:

1. **PMD** (`packages/pmd/`)
   - Daemon de registre
   - Gestion des nœuds
   - Heartbeats et TTL

2. **Core** (`packages/core/`)
   - NodeRuntime (singleton)
   - Mailbox (FIFO)
   - Transport (TCP)
   - PMD Client

3. **CLI** (`packages/cli/`)
   - Commandes d'administration
   - Interface avec PMD

Consultez `DEVELOPMENT.md` pour plus de détails.

## Ce qu'il ne faut PAS faire

❌ Changer l'API publique sans discussion  
❌ Ajouter des dépendances lourdes  
❌ Ignorer les règles de codage  
❌ Pusher du code qui ne build pas  
❌ Ignorer les tests qui échouent  
❌ Mélanger plusieurs changements dans un commit  

## Review process

1. Votre PR sera review par un mainteneur
2. Des changements peuvent être demandés
3. Une fois approuvée, la PR sera merged
4. Les PRs inactives pendant 30 jours seront fermées

## Questions ?

- Ouvrez une issue pour les questions générales
- Commentez sur une issue existante pour les questions spécifiques
- Lisez DEVELOPMENT.md pour les détails techniques

## License

En contribuant, vous acceptez que vos contributions soient sous la même license MIT que le projet.

Merci de contribuer à distflow! 🚀

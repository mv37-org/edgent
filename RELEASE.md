# Release Checklist

Use this checklist when publishing Edgent to npm.

1. Confirm the scoped package name is still available:

   ```sh
   npm view @mv37/edgent
   ```

   A 404 means the package has not been published. You must also have access to publish under the `@mv37` npm scope. If the scope does not exist, create the `mv37` npm organization or use an npm account that owns that scope.

2. Verify the package:

   ```sh
   npm install
   npm run typecheck
   npm run lint
   npm run test
   npm run build
   npm pack --dry-run
   ```

3. Log in to npm:

   ```sh
   npm login
   npm whoami
   ```

4. Publish the first public release:

   ```sh
   npm publish --access public
   ```

   For npm provenance from GitHub Actions, publish from CI with:

   ```sh
   npm publish --provenance --access public
   ```

5. Confirm the package page:

   ```sh
   npm view @mv37/edgent version
   ```

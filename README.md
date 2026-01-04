# Firestore Shared Configuration

This directory contains all shared Firestore configuration files used across multiple projects (admin-dashboard, android-app, and website).

## Purpose

To maintain a single source of truth for Firestore configuration and prevent file conflicts when changes are made from different projects.

## Directory Structure

```
firestore-shared/
├── firestore.rules           # Firestore security rules
├── firestore.indexes.json    # Firestore composite indexes
├── firebase.json             # Firebase project configuration
├── .firebaserc              # Firebase project mapping
├── functions/               # Cloud Functions
│   ├── index.js            # Functions entry point
│   ├── social.js           # Social features (follow/like)
│   ├── package.json        # Functions dependencies
│   └── .eslintrc.js        # ESLint configuration
└── README.md               # This file
```

## Files Overview

### firestore.rules
Contains Firestore security rules with:
- Role-based access control (ADMIN, SUPER_ADMIN, SPONSOR)
- Collection-level permissions
- Subcollection security rules
- Field-level validation
- Helper functions for authorization

**Last Updated:** Migrated from android-app (most comprehensive version)

### firestore.indexes.json
Contains 60+ composite indexes for optimal query performance across collections:
- blogs, challenges, discoveries, ratings, redemptions
- rewards, sponsorAnalytics, sponsors, spots
- user_challenges, user_visits, users

### firebase.json
Firebase CLI deployment configuration pointing to:
- Firestore rules and indexes
- Cloud Functions with predeploy linting

### .firebaserc
Firebase project configuration:
- Default project: `mysteryspot-ef091`

### functions/
Cloud Functions for backend operations:
- `toggleFollow` / `toggleLike` - Social interaction handlers
- `checkFollowStatus` / `checkLikeStatus` - Status checkers
- `batchCheckFollowStatus` / `batchCheckLikeStatus` - Batch operations
- Firestore trigger handlers for counter updates

## Usage

### For Android App Development

When working on the android-app:

1. **Before making changes:**
   ```bash
   cd /Users/birjukumar/Project-Spotshunt/android-app
   # Ensure you're working with the shared files
   ln -sf ../firestore-shared/firestore.rules firestore.rules
   ln -sf ../firestore-shared/firestore.indexes.json firestore.indexes.json
   ln -sf ../firestore-shared/firebase.json firebase.json
   ln -sf ../firestore-shared/.firebaserc .firebaserc
   ln -sf ../firestore-shared/functions functions
   ```

2. **Make changes directly in firestore-shared/ directory**

3. **Deploy:**
   ```bash
   cd /Users/birjukumar/Project-Spotshunt/firestore-shared
   firebase deploy --only firestore:rules
   firebase deploy --only firestore:indexes
   firebase deploy --only functions
   ```

### For Admin Dashboard Development

When working on the admin-dashboard:

1. **Link to shared files:**
   ```bash
   cd /Users/birjukumar/Project-Spotshunt/admin-dashboard
   # Remove old file if exists
   rm -f firestore-security-rules.rules
   # Create symlinks
   ln -sf ../firestore-shared/firestore.rules firestore.rules
   ln -sf ../firestore-shared/firestore.indexes.json firestore.indexes.json
   ln -sf ../firestore-shared/firebase.json firebase.json
   ln -sf ../firestore-shared/.firebaserc .firebaserc
   ln -sf ../firestore-shared/functions functions
   ```

2. **Make changes in firestore-shared/ directory**

3. **Deploy from firestore-shared directory**

### For Website Development

If the website needs Firestore deployment capabilities:

1. **Link to shared files:**
   ```bash
   cd /Users/birjukumar/Project-Spotshunt/website
   ln -sf ../firestore-shared/firestore.rules firestore.rules
   ln -sf ../firestore-shared/firestore.indexes.json firestore.indexes.json
   ln -sf ../firestore-shared/firebase.json firebase.json
   ln -sf ../firestore-shared/.firebaserc .firebaserc
   ```

## Important Notes

1. **Single Source of Truth:** Always edit files in `firestore-shared/` directory, not in individual project folders

2. **Symbolic Links:** Use symbolic links in project directories to reference shared files

3. **Deployment:** Always deploy from the `firestore-shared/` directory to ensure consistency

4. **Version Control:**
   - Commit changes to `firestore-shared/` when Firestore configuration changes
   - Document significant rule or index changes in commit messages

5. **Testing Before Deployment:**
   ```bash
   # Test rules locally
   cd firestore-shared
   firebase emulators:start --only firestore
   ```

6. **Backup Strategy:** The android-app directory still contains the original files as a backup

## Migration Status

- ✅ Firestore rules migrated from android-app (latest version)
- ✅ Firestore indexes migrated from android-app
- ✅ Firebase configuration files migrated
- ✅ Cloud Functions migrated
- ⚠️ Old admin-dashboard rules file preserved at `admin-dashboard/firestore-security-rules.rules` (recommend backup then delete)

## Common Commands

```bash
# Deploy everything
cd firestore-shared
firebase deploy

# Deploy only rules
firebase deploy --only firestore:rules

# Deploy only indexes
firebase deploy --only firestore:indexes

# Deploy only functions
firebase deploy --only functions

# View current project
firebase projects:list

# Run local emulator
firebase emulators:start
```

## Troubleshooting

**Q: Changes not reflecting after deployment?**
- Ensure you're editing files in `firestore-shared/` not in project directories
- Check that symbolic links are correctly pointing to shared files
- Verify deployment completed without errors

**Q: Deployment fails with "missing file" error?**
- Ensure you're deploying from the `firestore-shared/` directory
- Check that firebase.json paths are correct

**Q: Need to add project-specific rules?**
- All rules should be in the shared file
- Use conditions based on request data or resource data to differentiate behavior
- Avoid project-specific rule files

## Git Repository Setup

This firestore-shared folder is maintained as a separate Git repository for better version control and sharing across projects.

### Initial Setup (Already Done)

```bash
cd firestore-shared
git init
git add .
git commit -m "Initial commit: Firestore shared configuration"
```

### Pushing to Remote Repository

1. **Create a new repository on GitHub/GitLab/Bitbucket** (e.g., `spotshunt-firestore-config`)

2. **Add remote and push:**
   ```bash
   cd /Users/birjukumar/Project-Spotshunt/firestore-shared
   git remote add origin <your-repository-url>
   git branch -M main
   git push -u origin main
   ```

### Making Changes

1. **Edit files in firestore-shared/**
2. **Commit changes:**
   ```bash
   cd /Users/birjukumar/Project-Spotshunt/firestore-shared
   git add .
   git commit -m "Description of changes"
   git push
   ```

### Pulling Latest Changes

When working from different projects or machines:

```bash
cd /Users/birjukumar/Project-Spotshunt/firestore-shared
git pull origin main
```

### Using as Git Submodule (Optional)

If you want to include this repository in your main project repositories:

```bash
# In android-app or admin-dashboard repository
git submodule add <firestore-shared-repo-url> firestore-shared
git submodule update --init --recursive
```

### Best Practices

1. **Commit Frequently:** Commit changes to rules/indexes with descriptive messages
2. **Pull Before Edit:** Always pull latest changes before making edits
3. **Test Before Push:** Test rules locally with emulator before pushing
4. **Document Changes:** Use clear commit messages explaining rule changes
5. **Code Review:** Consider PR reviews for significant security rule changes

### Example Workflow

```bash
# Pull latest changes
cd firestore-shared
git pull

# Make your changes to firestore.rules or other files
# ...

# Test locally (optional but recommended)
firebase emulators:start --only firestore

# Commit and push
git add .
git commit -m "feat: Add read permissions for public profiles

- Updated users collection read rules
- Added isPublicProfile helper function
- Allows authenticated users to view public profiles"
git push

# Deploy to Firebase
firebase deploy --only firestore:rules
```

## Contact

For questions or issues with shared Firestore configuration, consult the project documentation or team lead.

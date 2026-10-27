# Simple Blog (GET / POST / PATCH / PUT / DELETE + authentication)

A tiny blog demonstrating CRUD endpoints, password authentication, and Google sign-in.
It requires Node 18 or newer and PostgreSQL.

## Run it

```bash
cd blog-app
npm install
npm start
```

Open http://localhost:3000. Configure `DATABASE_URL` in `.env` and create the tables
using the schema described in the project setup. Google sign-in is optional until its
OAuth credentials are configured.

## Google sign-in

1. In Google Cloud Console, create an OAuth client ID for a Web application.
2. Add `http://localhost:3000/api/auth/google/callback` as an authorized redirect URI.
3. Add these values to the root `.env` file (it is ignored by git):

```env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
# Optional for localhost on port 3000; required for production or a custom port.
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
```

The server validates Google's ID token, creates or reuses the local user, then issues
the same API session token used by password login. For deployment, use HTTPS and set
`GOOGLE_CALLBACK_URL` to the exact public callback URL registered with Google.

Posts are saved in `data.json` (created automatically). Delete that file to reset everything.

## Project structure

```
blog-app/
  server.js        <- the API + static file server
  package.json
  public/
    index.html
    style.css
    app.js         <- front-end code that calls the API with fetch()
```

## API

| Method | Route               | Auth? | What it does                        |
| ------ | ------------------- | ----- | ----------------------------------- |
| POST   | /api/register       | no    | create account, returns a token     |
| POST   | /api/login          | no    | log in, returns a token             |
| POST   | /api/logout         | yes   | invalidates your token              |
| GET    | /api/me             | yes   | who am I                            |
| GET    | /api/auth/google    | no    | start Google sign-in                |
| GET    | /api/auth/google/callback | no | Google OAuth callback               |
| GET    | /api/posts          | no    | list posts (`?search=word` to filter) |
| GET    | /api/posts/:id      | no    | one post                            |
| POST   | /api/posts          | yes   | create a post                       |
| PATCH  | /api/posts/:id      | yes   | edit part of your post              |
| PUT    | /api/posts/:id      | yes   | replace your post (title + content) |
| DELETE | /api/posts/:id      | yes   | delete your post                    |

Authenticated requests send the header `Authorization: Bearer <token>`.
You can only edit or delete your own posts.

## Try it with curl

```bash
# register (copy the token from the response)
curl -X POST localhost:3000/api/register -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"secret123"}'

# create a post
curl -X POST localhost:3000/api/posts -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" -d '{"title":"Hello","content":"First post"}'

# list posts
curl localhost:3000/api/posts

# edit (use the id from the create response)
curl -X PATCH localhost:3000/api/posts/POST_ID -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" -d '{"title":"Hello again"}'

# delete
curl -X DELETE localhost:3000/api/posts/POST_ID -H "Authorization: Bearer YOUR_TOKEN"
```

## Notes

This is a learning demo. Passwords are hashed with scrypt and tokens are random,
but for a real site you would add things like HTTPS, rate limiting, token expiry and a real database.

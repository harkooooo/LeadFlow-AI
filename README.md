# LeadFlow AI

LeadFlow AI is a full-stack MERN application that helps businesses qualify leads through an AI-powered chat and manage them in an admin dashboard.

## Live Demo

Frontend:
https://lead-flow-ai-weld.vercel.app

Backend:
https://leadflow-backend-76jm.onrender.com

## Tech Stack

- React
- Vite
- Node.js
- Express
- MongoDB
- Mongoose
- OpenAI API
- JWT
- bcrypt
- express-rate-limit

## Features

- AI-powered lead qualification chat
- Backend-controlled conversation state
- Lead information preserved across messages
- Service selection based on the company's real service list
- Lead is saved only after explicit confirmation
- Admin login with JWT authentication
- Protected backend routes
- Lead search and filtering
- Lead status management
- Lead deletion
- Rate limiting
- Restricted CORS configuration
- Session locking to prevent overlapping chat requests

## Architecture

The AI model is mainly used to interpret the customer's latest message.

The backend owns the conversation state, decides what information is still needed, controls the next step in the flow, and decides when a lead can be saved.

This prevents the AI model from freely overwriting important lead data or controlling application state.

Basic flow:

```text
Customer
   ↓
React frontend
   ↓
Express API
   ↓
AI interpreter
   ↓
Backend conversation logic
   ↓
MongoDB
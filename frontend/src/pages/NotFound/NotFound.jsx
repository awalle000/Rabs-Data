import { Link } from 'react-router-dom';
import EmptyState from '../../components/EmptyState/EmptyState.jsx';
import './NotFound.css';

export default function NotFound() {
  return (
    <div className="container page not-found">
      <EmptyState
        icon="search"
        title="Page not found"
        message="The page you are looking for doesn't exist or has moved."
        action={
          <Link to="/" className="btn btn--primary">
            Back to home
          </Link>
        }
      />
    </div>
  );
}